import { createHash } from 'node:crypto';
import { type ApprovalInput, type ApprovalRefusal, type GateReply, gateApproval } from './approval-gate.js';
import type { ApprovalSigner } from './approval.js';
import { normalizeWrite, type Outcome, type OutcomeStatus } from './outcomes.js';
import type { AlexaPort } from './ports.js';
import type { Catalog, SpeakerFlags } from './catalog.js';
import type { OperationContext, SqliteJournal } from './sqlite-journal.js';

export type SpeakPolicy = 'off' | 'approve' | 'allow';
export const MAX_SPEECH_CHARS = 250;
export const DEFAULT_VOLUME_MAX = 70;
export const SPEECH_LIMIT = { count: 5, windowMs: 10 * 60_000 };

export type SpeechRefusal = 'invalid_text' | 'invalid_level' | 'target_not_allowed' | 'device_offline' | 'rate_limited' | 'speech_off' | ApprovalRefusal;

export interface SpeechReply {
  status: OutcomeStatus | 'approval_required' | 'confirmation_required';
  reason?: SpeechRefusal;
  operationId?: string;
  question?: string;
  approvalId?: string;
  instructions?: string;
  approval?: { inputRequests: Record<string, unknown>; requestState: string };
}

export interface Speaker {
  name: string;
  online: boolean;
}

export interface Echo {
  serial: string;
  name: string;
  online: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Control characters are stripped; anything that looks like markup is refused rather than escaped.
export function cleanText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > MAX_SPEECH_CHARS || /[<>]/.test(text)) return undefined;
  return text;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

export function echoesOf(body: unknown): Echo[] {
  const devices = isRecord(body) && Array.isArray(body.devices) ? body.devices : [];
  const found: Echo[] = [];
  for (const device of devices) {
    if (!isRecord(device)) continue;
    const serial = device.serialNumber;
    const name = device.accountName;
    if (typeof serial !== 'string' || typeof name !== 'string' || !serial || !name) continue;
    found.push({ serial, name, online: device.online === true });
  }
  return found;
}

// Says short texts on the owner's allowed Echo devices. Records hold only a digest, a target count and the outcome.
export class SpeechService {
  private readonly attempts: number[] = [];

  onApprovalRequested?: (summary: string) => void;
  onUrgent?: (reason: string) => void;
  private readonly urgentAttempts: number[] = [];

  constructor(
    private readonly adapter: AlexaPort,
    private readonly journal: SqliteJournal,
    private readonly settings: { policy: SpeakPolicy; targets: readonly string[]; urgentReasons?: readonly string[]; urgentLimit?: number; volumeMax?: number; catalog?: () => Catalog },
    private readonly approvals: ApprovalSigner | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Once any Echo has speaker flags in the catalog, the flags decide and SPEAK_TARGETS is ignored.
  private flagged(): boolean {
    for (const entry of this.settings.catalog?.().values() ?? []) if (entry.speaker) return true;
    return false;
  }

  private flags(echo: Echo): SpeakerFlags | undefined {
    return this.settings.catalog?.().get(echo.serial)?.speaker;
  }

  private allowed(echo: Echo, use: 'announce' | 'volume' = 'announce'): boolean {
    if (this.flagged()) return this.flags(echo)?.[use] === true;
    const { targets } = this.settings;
    return targets.includes('*') || targets.some((t) => t.toLowerCase() === echo.name.toLowerCase() || t === echo.serial);
  }

  async speakers(): Promise<Speaker[]> {
    if (this.settings.policy === 'off') return [];
    const echoes = echoesOf(await this.adapter.echoDevices());
    return echoes.filter((e) => this.allowed(e) || this.allowed(e, 'volume')).map((e) => ({ name: e.name, online: e.online }));
  }

  private overLimit(at: number, window = this.attempts, max = SPEECH_LIMIT.count): boolean {
    while (window.length > 0 && at - (window[0] as number) >= SPEECH_LIMIT.windowMs) window.shift();
    return window.length >= max;
  }

  async say(
    context: OperationContext,
    request: { text: unknown; mode: 'speak' | 'announce'; devices: string[]; reason?: unknown },
    approval: ApprovalInput = { canElicit: false },
  ): Promise<SpeechReply> {
    if (this.settings.policy === 'off') return { status: 'rejected', reason: 'speech_off' };
    const text = cleanText(request.text);
    if (!text) return { status: 'rejected', reason: 'invalid_text' };
    const wanted = [...new Set(request.devices.map((d) => d.trim().toLowerCase()).filter(Boolean))];
    if (wanted.length === 0 || (request.mode === 'speak' && wanted.length !== 1)) return { status: 'rejected', reason: 'target_not_allowed' };

    let echoes: Echo[];
    try {
      echoes = echoesOf(await this.adapter.echoDevices());
    } catch {
      return { status: 'not_dispatched' };
    }
    const chosen = wanted.map((name) => echoes.find((e) => this.allowed(e) && (e.name.toLowerCase() === name || e.serial.toLowerCase() === name)));
    // Unknown and disallowed devices get the same answer.
    if (chosen.some((e) => e === undefined)) return { status: 'rejected', reason: 'target_not_allowed' };
    const targets = [...new Map((chosen as Echo[]).map((e) => [e.serial, e])).values()];
    if (targets.some((e) => !e.online)) return { status: 'rejected', reason: 'device_offline' };
    const at = this.now().getTime();
    const reason = typeof request.reason === 'string' ? request.reason.trim().toLowerCase() : '';
    const urgent = reason !== '' && (this.settings.urgentReasons ?? []).includes(reason)
      && (!this.flagged() || targets.every((e) => this.flags(e)?.urgent === true));
    // Over the urgent limit is a refusal, never a downgrade to the approval path.
    if (urgent && this.overLimit(at, this.urgentAttempts, this.settings.urgentLimit ?? 2)) return { status: 'rejected', reason: 'rate_limited' };
    if (!urgent && this.overLimit(at)) return { status: 'rejected', reason: 'rate_limited' };

    const serials = targets.map((e) => e.serial).sort();
    const targetId = `speech:${digest(serials.join('|'))}`;
    const parameters = { text, mode: request.mode };
    let nonce: string | undefined;
    if (this.settings.policy === 'approve' && !urgent) {
      const names = targets.map((e) => e.name).join(', ');
      const summary = `${request.mode === 'speak' ? 'say' : 'announce'} "${text}" on ${names}`;
      const gate: { nonce: string } | GateReply = await gateApproval(
        { signer: this.approvals, journal: this.journal, now: this.now, onApprovalRequested: this.onApprovalRequested },
        context, targetId, 'speech', parameters, summary, approval, process.env.CHAT_CONFIRMATION !== 'off',
      );
      if ('status' in gate) return gate as SpeechReply;
      nonce = gate.nonce;
    }

    let opened;
    try {
      opened = await this.journal.open(context, urgent ? `speech-urgent:${reason}` : 'speech', { targetId, parameters }, [`speech:${targets.length}`], this.now());
    } catch {
      return { status: 'not_dispatched' };
    }
    if (opened.kind !== 'created') return { status: 'rejected', reason: 'approval_invalid' };
    const operationId = opened.record.operationId;
    if (nonce) {
      try { this.journal.linkApproval(nonce, operationId); } catch { /* audit link only */ }
    }

    (urgent ? this.urgentAttempts : this.attempts).push(this.now().getTime());
    if (urgent) {
      try { this.onUrgent?.(reason); } catch { /* the doorbell never blocks the announcement */ }
    }
    let outcome: Outcome;
    try {
      const response = await this.adapter.speak(serials, request.mode, text);
      outcome = normalizeWrite(response, (body) => {
        if (isRecord(body) && ((Array.isArray(body.errors) && body.errors.length > 0) || body.success === false)) return { status: 'failed' };
        return { status: 'accepted' };
      });
    } catch {
      outcome = { status: 'unknown' };
    }
    try { await this.journal.end(operationId, outcome, this.now()); } catch { /* recovery reports unknown */ }
    return { status: outcome.status, operationId };
  }

  // Sets one allowed Echo's volume, clamped to the ceiling. Always approved unless the policy is allow.
  async setVolume(
    context: OperationContext,
    request: { device: string; level: unknown },
    approval: ApprovalInput = { canElicit: false },
  ): Promise<SpeechReply & { level?: number }> {
    if (this.settings.policy === 'off') return { status: 'rejected', reason: 'speech_off' };
    if (typeof request.level !== 'number' || !Number.isInteger(request.level) || request.level < 0 || request.level > 100) {
      return { status: 'rejected', reason: 'invalid_level' };
    }
    const name = request.device.trim().toLowerCase();
    let echoes: Echo[];
    try {
      echoes = echoesOf(await this.adapter.echoDevices());
    } catch {
      return { status: 'not_dispatched' };
    }
    const echo = name ? echoes.find((e) => this.allowed(e, 'volume') && (e.name.toLowerCase() === name || e.serial.toLowerCase() === name)) : undefined;
    if (!echo) return { status: 'rejected', reason: 'target_not_allowed' };
    const level = Math.min(request.level, this.flags(echo)?.volumeMax ?? this.settings.volumeMax ?? DEFAULT_VOLUME_MAX, this.settings.volumeMax ?? DEFAULT_VOLUME_MAX);
    if (!echo.online) return { status: 'rejected', reason: 'device_offline' };
    const at = this.now().getTime();
    if (this.overLimit(at)) return { status: 'rejected', reason: 'rate_limited' };

    const targetId = `speech:${digest(echo.serial)}`;
    const parameters = { level };
    let nonce: string | undefined;
    if (this.settings.policy === 'approve') {
      const gate: { nonce: string } | GateReply = await gateApproval(
        { signer: this.approvals, journal: this.journal, now: this.now, onApprovalRequested: this.onApprovalRequested },
        context, targetId, 'volume', parameters, `set the volume of ${echo.name} to ${level}`, approval, process.env.CHAT_CONFIRMATION !== 'off',
      );
      if ('status' in gate) return gate as SpeechReply;
      nonce = gate.nonce;
    }
    let opened;
    try {
      opened = await this.journal.open(context, 'volume', { targetId, parameters }, ['speech:1'], this.now());
    } catch {
      return { status: 'not_dispatched' };
    }
    if (opened.kind !== 'created') return { status: 'rejected', reason: 'approval_invalid' };
    const operationId = opened.record.operationId;
    if (nonce) {
      try { this.journal.linkApproval(nonce, operationId); } catch { /* audit link only */ }
    }
    this.attempts.push(at);
    let outcome: Outcome;
    try {
      outcome = normalizeWrite(await this.adapter.setVolume(echo.serial, level), (body) => {
        if (isRecord(body) && ((Array.isArray(body.errors) && body.errors.length > 0) || body.success === false)) return { status: 'failed' };
        return { status: 'accepted' };
      });
    } catch {
      outcome = { status: 'unknown' };
    }
    try { await this.journal.end(operationId, outcome, this.now()); } catch { /* recovery reports unknown */ }
    return { status: outcome.status, operationId, level };
  }
}
