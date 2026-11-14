import { createHash } from 'node:crypto';
import type { AlexaAdapter } from './alexa-adapter.js';
import { checkApproval } from './approvals.js';
import { assertNotExcluded } from './excluded-devices.js';
import { Journal, journaledDispatch } from './journal.js';
import { normalizeSimpleBody, normalizeWrite, type Outcome } from './outcomes.js';

type RoutineAdapter = Pick<AlexaAdapter, 'routines' | 'runRoutine'>;

export type RoutineProbeResult =
  | { ran: false; outcome: Outcome; reason: 'not_approved' | 'approval_mismatch' | 'definition_unreadable' | 'excluded_class' | 'not_found' | 'journal_unavailable' }
  | { ran: true; outcome: Outcome; definitionHash: string; operationId?: string | undefined };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function routineDefinitionHash(routine: unknown): string {
  // Alexa regenerates sequence.sequenceId on every fetch, so it cannot be part of a stable hash.
  if (isRecord(routine) && isRecord(routine.sequence)) {
    const sequence = { ...routine.sequence };
    delete sequence.sequenceId;
    routine = { ...routine, sequence };
  }
  return createHash('sha256').update(stable(routine)).digest('hex');
}

function findRoutine(body: unknown, id: string): Record<string, unknown> | undefined {
  const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.automations) ? body.automations : undefined;
  return list?.find((item): item is Record<string, unknown> => isRecord(item) && item.automationId === id);
}

export interface RoutineProbeRequest {
  routineId: string;
  device: string;
  approvalFile: string;
  journal: Journal;
  now?: Date;
}

// The routine is run by stable ID only after its definition has been read; the owner approves its hash.
export async function runRoutineProbe(adapter: RoutineAdapter, request: RoutineProbeRequest): Promise<RoutineProbeResult> {
  const blocked = (reason: Extract<RoutineProbeResult, { ran: false }>['reason'], status: Outcome['status'] = 'not_dispatched'): RoutineProbeResult =>
    ({ ran: false, outcome: { status }, reason });

  let routine: Record<string, unknown> | undefined;
  try {
    routine = findRoutine(await adapter.routines(2000), request.routineId);
  } catch {
    return blocked('definition_unreadable');
  }
  if (!routine) return blocked('not_found');
  if (!isRecord(routine.sequence) || typeof routine.sequence.sequenceId !== 'string') return blocked('definition_unreadable');

  const excluded = assertNotExcluded({ capabilities: routine.sequence });
  if (!excluded.allowed) return blocked('excluded_class', 'rejected');

  const definitionHash = routineDefinitionHash(routine);
  const decision = await checkApproval(
    request.approvalFile,
    { probe: 'routine-run', targets: [request.routineId], args: { routineId: request.routineId, definitionHash } },
    request.now,
  );
  if (!decision.approved) return blocked(decision.reason === 'mismatched' ? 'approval_mismatch' : 'not_approved');

  const result = await journaledDispatch(
    request.journal,
    'routine-run',
    { routineId: request.routineId, definitionHash },
    [request.routineId],
    async () => normalizeWrite(await adapter.runRoutine(request.device, routine), (body) => normalizeSimpleBody(body, request.routineId)),
  );
  if (result.outcome.status === 'not_dispatched') return blocked('journal_unavailable');
  return { ran: true, outcome: result.outcome, definitionHash, operationId: result.operationId };
}
