import type { AlexaAdapter } from './alexa-adapter.js';
import { checkApproval } from './approvals.js';
import { assertNotExcluded, type DeviceDescriptor } from './excluded-devices.js';
import { Journal, journaledDispatch } from './journal.js';
import { normalizeDeviceControlBody, normalizeWrite, verified, type Outcome } from './outcomes.js';
import { readDeviceState } from './read-probes.js';

type MutationAdapter = Pick<AlexaAdapter, 'controlDevice' | 'deviceState'>;

export interface Expectation {
  namespace: string;
  name: string;
  value: unknown;
}

export interface MutationRequest {
  entityId: string;
  descriptor: DeviceDescriptor | undefined;
  parameters: unknown[];
  expect?: Expectation;
  approvalFile: string;
  journal: Journal;
  now?: Date;
}

export type MutationResult =
  | { ran: false; outcome: Outcome; reason: 'device_not_inspectable' | 'excluded_class' | 'not_approved' | 'approval_mismatch' | 'journal_unavailable' }
  | { ran: true; outcome: Outcome; operationId?: string | undefined };

export const mutationArgs = (entityId: string, parameters: unknown[]) => ({ entityId, parameters });

// One owner-approved, low-impact smart-home write. The device class must be known and not excluded.
export async function runMutationProbe(adapter: MutationAdapter, request: MutationRequest): Promise<MutationResult> {
  const blocked = (reason: Extract<MutationResult, { ran: false }>['reason'], status: Outcome['status'] = 'not_dispatched'): MutationResult =>
    ({ ran: false, outcome: { status }, reason });

  if (!request.descriptor) return blocked('device_not_inspectable');
  if (!assertNotExcluded(request.descriptor).allowed) return blocked('excluded_class', 'rejected');

  const decision = await checkApproval(
    request.approvalFile,
    { probe: 'device-mutation', targets: [request.entityId], args: mutationArgs(request.entityId, request.parameters) },
    request.now,
  );
  if (!decision.approved) return blocked(decision.reason === 'mismatched' ? 'approval_mismatch' : 'not_approved');

  const result = await journaledDispatch(
    request.journal,
    'device-mutation',
    mutationArgs(request.entityId, request.parameters),
    [request.entityId],
    async () => {
      let outcome = normalizeWrite(
        await adapter.controlDevice(request.entityId, request.parameters),
        (body) => normalizeDeviceControlBody(body, [request.entityId]),
      );
      if (outcome.status === 'accepted' && request.expect) {
        const readAt = new Date();
        const state = await readDeviceState(adapter as never, request.entityId, readAt);
        const match = state.status === 'ok' && state.items.some((item) =>
          item.namespace === request.expect?.namespace && item.property === request.expect.name
          && JSON.stringify(item.value) === JSON.stringify(request.expect.value));
        if (match) outcome = verified(outcome, 'state_read', readAt);
      }
      return outcome;
    },
  );
  if (result.outcome.status === 'not_dispatched') return blocked('journal_unavailable');
  return { ran: true, outcome: result.outcome, operationId: result.operationId };
}
