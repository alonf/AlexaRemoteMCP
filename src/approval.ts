import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const APPROVAL_INPUT_KEY = 'approval';
export const APPROVAL_TTL_MS = 2 * 60_000;

export interface ApprovalBinding {
  subject: string;
  targetId: string;
  // Digest of the exact action and parameters, so approval for one action cannot authorize another.
  request: string;
}

export type ApprovalVerdict =
  | { ok: true; nonce: string; issuedAt: number }
  | { ok: false; reason: 'approval_invalid' | 'approval_expired'; nonce?: string };

interface Payload extends ApprovalBinding {
  exp: number;
  iat?: number;
  nonce: string;
}

const encode = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export const digestOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// MRTR request state is attacker-controlled: it is signed, expires, and is bound to the principal and the exact action.
export class ApprovalSigner {
  constructor(private readonly key: Buffer, private readonly ttlMs = APPROVAL_TTL_MS) {}

  private sign(body: string): string {
    return encode(createHmac('sha256', this.key).update(body).digest());
  }

  issue(binding: ApprovalBinding, now: Date): { state: string; nonce: string; expiresAt: Date } {
    const payload: Payload = { ...binding, exp: now.getTime() + this.ttlMs, iat: now.getTime(), nonce: randomUUID() };
    const body = encode(JSON.stringify(payload));
    return { state: `${body}.${this.sign(body)}`, nonce: payload.nonce, expiresAt: new Date(payload.exp) };
  }

  verify(state: unknown, binding: ApprovalBinding, now: Date): ApprovalVerdict {
    const invalid: ApprovalVerdict = { ok: false, reason: 'approval_invalid' };
    if (typeof state !== 'string' || state.length > 2048) return invalid;
    const [body, signature, ...rest] = state.split('.');
    if (!body || !signature || rest.length > 0) return invalid;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return invalid;
    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    } catch {
      return invalid;
    }
    if (typeof payload.nonce !== 'string' || typeof payload.exp !== 'number') return invalid;
    if (payload.subject !== binding.subject || payload.targetId !== binding.targetId || payload.request !== binding.request) {
      return { ok: false, reason: 'approval_invalid', nonce: payload.nonce };
    }
    if (now.getTime() > payload.exp) return { ok: false, reason: 'approval_expired', nonce: payload.nonce };
    return { ok: true, nonce: payload.nonce, issuedAt: typeof payload.iat === 'number' ? payload.iat : now.getTime() };
  }
}

export function approvalInputRequest(message: string) {
  return {
    [APPROVAL_INPUT_KEY]: {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message,
        requestedSchema: {
          type: 'object',
          properties: { approve: { type: 'boolean', title: 'Approve this action' } },
          required: ['approve'],
        },
      },
    },
  };
}

// Only an explicit accept with approve=true is approval; anything else the client returns counts as a refusal.
export function readApprovalResponse(inputResponses: unknown): 'accepted' | 'declined' | 'missing' {
  if (inputResponses === null || typeof inputResponses !== 'object') return 'missing';
  const response = (inputResponses as Record<string, unknown>)[APPROVAL_INPUT_KEY];
  if (response === null || typeof response !== 'object') return 'missing';
  const { action, content } = response as { action?: unknown; content?: unknown };
  if (action !== 'accept') return 'declined';
  const approve = content !== null && typeof content === 'object' ? (content as Record<string, unknown>).approve : undefined;
  return approve === true ? 'accepted' : 'declined';
}
