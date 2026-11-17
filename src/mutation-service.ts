import { evaluateMutationPolicy, type MutationAction, type MutationPolicy, type PolicyRefusal } from './mutation-policy.js';
import { normalizeDeviceControlBody, normalizeWrite, verified, type Outcome, type OutcomeStatus } from './outcomes.js';
import type { AlexaPort } from './ports.js';
import { readDeviceState } from './read-probes.js';
import { type OperationContext, SqliteJournal } from './sqlite-journal.js';
import { TargetOrdering } from './target-ordering.js';

export type LightCommand =
  | { kind: 'power'; on: boolean }
  | { kind: 'brightness'; level: number };

export interface MutationReply {
  status: OutcomeStatus | 'key_conflict';
  operationId?: string;
  reason?: PolicyRefusal;
  replayed?: boolean;
  verification?: Outcome['verification'];
}

const OPERATION_NAMES = { power: 'light-power', brightness: 'light-brightness' } as const;

function describe(command: LightCommand): { action: MutationAction; parameters: unknown; expect: { namespace: string; name: string; value: unknown } } {
  if (command.kind === 'power') {
    return {
      action: 'power',
      parameters: { action: command.on ? 'turnOn' : 'turnOff' },
      expect: { namespace: 'Alexa.PowerController', name: 'powerState', value: command.on ? 'ON' : 'OFF' },
    };
  }
  return {
    action: 'brightness',
    parameters: { action: 'setBrightness', brightness: command.level },
    expect: { namespace: 'Alexa.BrightnessController', name: 'brightness', value: command.level },
  };
}

// The single path for allow-listed light mutations: policy, then journal, then ordered dispatch and verification.
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
  ) {}

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

  async execute(context: OperationContext, targetId: string, command: LightCommand): Promise<MutationReply> {
    const { action, parameters, expect } = describe(command);

    const decision = await evaluateMutationPolicy(this.cachedInventory, this.policy, targetId, action);
    if (!decision.allowed) return { status: 'rejected', reason: decision.reason };

    const controlId = decision.controlId;
    const args = { targetId, parameters };
    let opened;
    try {
      opened = await this.journal.open(context, OPERATION_NAMES[command.kind], args, [targetId], this.now());
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
    let outcome: Outcome;
    try {
      outcome = await this.ordering.run([targetId], async (order) => {
        let result = await order.step(() => this.dispatch(controlId, parameters));
        if (result.status === 'accepted') {
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
    return {
      status: outcome.status,
      operationId,
      ...(outcome.verification ? { verification: outcome.verification } : {}),
    };
  }
}
