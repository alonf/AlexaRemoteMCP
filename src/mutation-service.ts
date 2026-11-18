import { type ApprovalSigner } from './approval.js';
import { type ApprovalInput, type ApprovalRefusal, gateApproval } from './approval-gate.js';
import { evaluateMutationPolicy, type MutationAction, type MutationPolicy, type PolicyRefusal, type PositionDirection } from './mutation-policy.js';
import { normalizeDeviceControlBody, normalizeWrite, verified, type Outcome, type OutcomeStatus } from './outcomes.js';
import type { AlexaPort } from './ports.js';
import type { Operation } from './catalog.js';
import { readDeviceState } from './read-probes.js';
import { type OperationContext, SqliteJournal } from './sqlite-journal.js';
import { TargetOrdering } from './target-ordering.js';

export type DeviceCommand =
  | { kind: 'power'; on: boolean }
  | { kind: 'brightness'; level: number }
  | { kind: 'position'; direction: PositionDirection };

export interface MutationReply {
  status: OutcomeStatus | 'key_conflict' | 'approval_required' | 'confirmation_required';
  operationId?: string;
  reason?: PolicyRefusal | ApprovalRefusal;
  // Present only with `confirmation_required`: the spoken-confirmation fallback for clients that cannot elicit.
  question?: string;
  approvalId?: string;
  instructions?: string;
  replayed?: boolean;
  verification?: Outcome['verification'];
  // Present only with `approval_required`: the MRTR fields for the client to answer and retry.
  approval?: { inputRequests: Record<string, unknown>; requestState: string };
}

const OPERATION_NAMES = { power: 'device-power', brightness: 'device-brightness', position: 'device-position' } as const;

interface Description {
  action: MutationAction;
  direction?: PositionDirection;
  operation: Operation;
  parameters: unknown;
  phrase: string;
  expect?: { namespace: string; name: string; value: unknown };
}

function describe(command: DeviceCommand): Description {
  if (command.kind === 'power') {
    return {
      action: 'power',
      operation: command.on ? 'power_on' : 'power_off',
      parameters: { action: command.on ? 'turnOn' : 'turnOff' },
      phrase: command.on ? 'turn on' : 'turn off',
      expect: { namespace: 'Alexa.PowerController', name: 'powerState', value: command.on ? 'ON' : 'OFF' },
    };
  }
  if (command.kind === 'position') {
    // The parameters come from the device's own ModeController, resolved by the policy.
    const d = command.direction;
    const operation: Operation = d === 'open' || d === 'close' ? d : d.startsWith('stop') ? 'stop' : 'step';
    const phrase = d === 'open' || d === 'close' ? d
      : d === 'stop_up' ? 'stop the upward movement of'
        : d === 'stop_down' ? 'stop the downward movement of'
          : d === 'step_up' ? 'step up' : 'step down';
    return { action: 'position', direction: d, operation, parameters: undefined, phrase };
  }
  return {
    action: 'brightness',
    operation: 'brightness',
    parameters: { action: 'setBrightness', brightness: command.level },
    phrase: `set brightness to ${command.level}% on`,
    expect: { namespace: 'Alexa.BrightnessController', name: 'brightness', value: command.level },
  };
}

// The single path for device mutations: policy, optional owner approval, then journal, ordered dispatch and verification.
export class MutationService {
  private readonly ordering = new TargetOrdering();

  constructor(
    private readonly adapter: AlexaPort,
    private readonly journal: SqliteJournal,
    private readonly policy: MutationPolicy,
    private readonly now: () => Date = () => new Date(),
    private readonly retryDelaysMs: readonly number[] = [2000, 6000, 15000],
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly inventoryTtlMs = 5 * 60_000,
    private readonly approvals?: ApprovalSigner,
  ) {}

  onApprovalRequested?: (summary: string) => void;
  onCompleted?: (summary: string, status: string) => void;

  private inventory: { at: number; body: unknown } | undefined;

  // The policy check needs the inventory only to classify the target; a short cache keeps write bursts from
  // adding a full inventory read to every call. Failures are never cached.
  private readonly cachedInventory = {
    smartHomeDevices: async (): Promise<unknown> => {
      const at = this.now().getTime();
      if (this.inventory && at - this.inventory.at < this.inventoryTtlMs) return this.inventory.body;
      const body = await this.adapter.smartHomeDevices();
      this.inventory = { at, body };
      return body;
    },
  };

  // A 429 means Amazon refused before the skill ran, so retrying cannot duplicate the action.
  private async dispatch(controlId: string, parameters: unknown): Promise<Outcome> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.adapter.controlDevice(controlId, parameters);
      const delay = this.retryDelaysMs[attempt];
      if (response.status !== 'rate_limited' || delay === undefined) {
        return normalizeWrite(response, (body) => normalizeDeviceControlBody(body, [controlId]));
      }
      await this.sleep(delay);
    }
  }

  async execute(
    context: OperationContext,
    targetId: string,
    command: DeviceCommand,
    approval: ApprovalInput = { canElicit: false },
  ): Promise<MutationReply> {
    const described = describe(command);
    const { action, expect } = described;

    const startedAt = Date.now();
    const decision = await evaluateMutationPolicy(this.cachedInventory, this.policy, targetId, action, described.direction, described.operation);
    const policyMs = Date.now() - startedAt;
    if (!decision.allowed) return { status: 'rejected', reason: decision.reason };

    const controlId = decision.controlId;
    const parameters = decision.parameters ?? described.parameters;
    const operation = OPERATION_NAMES[command.kind];

    let approvedNonce: string | undefined;
    if (decision.mode === 'approve') {
      const gate = await gateApproval({ signer: this.approvals, journal: this.journal, now: this.now, onApprovalRequested: this.onApprovalRequested }, context, targetId, operation, parameters, `${described.phrase} "${decision.label}"`, approval, process.env.CHAT_CONFIRMATION !== 'off');
      // Timing only (no identifiers): shows whether the wait before an action is the inventory lookup or the approval step.
      console.log(`mutation-timing policy_ms=${policyMs} gate_ms=${Date.now() - startedAt - policyMs} result=${'status' in gate ? gate.status : 'approved'}`);
      if ('status' in gate) return gate;
      approvedNonce = gate.nonce;
    }

    const args = { targetId, parameters };
    let opened;
    try {
      opened = await this.journal.open(context, operation, args, [targetId], this.now());
    } catch {
      return { status: 'not_dispatched' };
    }
    if (opened.kind === 'key_conflict') return { status: 'key_conflict' };
    if (opened.kind === 'replayed') {
      const { outcome, operationId } = opened.record;
      return {
        status: outcome?.status ?? 'unknown',
        operationId,
        replayed: true,
        ...(outcome?.verification ? { verification: outcome.verification } : {}),
      };
    }

    const operationId = opened.record.operationId;
    if (approvedNonce) {
      try {
        this.journal.linkApproval(approvedNonce, operationId);
      } catch {
        // The approval is already consumed; the missing link only weakens the audit trail.
      }
    }
    let outcome: Outcome;
    try {
      outcome = await this.ordering.run([targetId], async (order) => {
        let result = await order.step(() => this.dispatch(controlId, parameters));
        if (result.status === 'accepted' && expect) {
          const readAt = this.now();
          const check = await order.step(async () => {
            const state = await readDeviceState(this.adapter, controlId, readAt);
            const match = state.status === 'ok' && state.items.some((item) =>
              item.namespace === expect.namespace && item.property === expect.name
              && JSON.stringify(item.value) === JSON.stringify(expect.value));
            return match ? verified(result, 'state_read', readAt) : result;
          });
          if (check.status === 'verified') result = check;
        }
        return result;
      });
    } catch {
      outcome = { status: 'unknown' };
    }
    try {
      await this.journal.end(operationId, outcome, this.now());
    } catch {
      // Recovery reports the incomplete record as unknown.
    }
    try { this.onCompleted?.(`${described.phrase} "${decision.label}"`, outcome.status); } catch { /* the doorbell never blocks the reply */ }
    return {
      status: outcome.status,
      operationId,
      ...(outcome.verification ? { verification: outcome.verification } : {}),
    };
  }
}
