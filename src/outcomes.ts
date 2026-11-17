import type { WriteResponse } from './write-outcome.js';

export type OutcomeStatus =
  | 'rejected'
  | 'not_dispatched'
  | 'accepted'
  | 'verified'
  | 'failed'
  | 'partially_applied'
  | 'superseded'
  | 'unknown';

export interface TargetOutcome {
  target: string;
  status: 'accepted' | 'failed' | 'unknown';
}

export interface Outcome {
  status: OutcomeStatus;
  targets?: TargetOutcome[];
  verification?: { source: string; at: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function aggregate(targets: TargetOutcome[]): Outcome {
  const accepted = targets.filter((t) => t.status === 'accepted').length;
  const failed = targets.filter((t) => t.status === 'failed').length;
  if (targets.length === 0) return { status: 'unknown' };
  if (accepted === targets.length) return { status: 'accepted', targets };
  if (accepted === 0 && failed === targets.length) return { status: 'failed', targets };
  if (accepted === 0) return { status: 'unknown', targets };
  return { status: 'partially_applied', targets };
}

// Smart-home control responses list per-device results and per-device errors.
export function normalizeDeviceControlBody(body: unknown, requested: string[]): Outcome {
  if (!isRecord(body)) return { status: 'unknown' };
  const responses = body.controlResponses ?? [];
  const errors = body.errors ?? [];
  if (!Array.isArray(responses) || !Array.isArray(errors)) return { status: 'unknown' };

  const state = new Map<string, TargetOutcome['status']>();
  for (const item of responses) {
    if (!isRecord(item)) return { status: 'unknown' };
    const id = typeof item.entityId === 'string' ? item.entityId : undefined;
    if (!id) return { status: 'unknown' };
    state.set(id, item.code === 'SUCCESS' ? 'accepted' : 'failed');
  }
  for (const item of errors) {
    const entity = isRecord(item) && isRecord(item.entity) ? item.entity : undefined;
    const id = entity && typeof entity.entityId === 'string' ? entity.entityId : undefined;
    if (!id) return { status: 'unknown' };
    state.set(id, 'failed');
  }
  const targets = requested.map((target) => ({ target, status: state.get(target) ?? 'unknown' }));
  return aggregate(targets);
}

// Single-target writes (routine, DND): success is only "accepted", never proof of execution.
export function normalizeSimpleBody(body: unknown, target: string): Outcome {
  if (body === null || body === undefined || body === '') return { status: 'unknown' };
  if (!isRecord(body)) return { status: 'unknown' };
  if ('errors' in body && Array.isArray(body.errors) && body.errors.length > 0) {
    return { status: 'failed', targets: [{ target, status: 'failed' }] };
  }
  if (body.success === false) return { status: 'failed', targets: [{ target, status: 'failed' }] };
  return { status: 'accepted', targets: [{ target, status: 'accepted' }] };
}

export function normalizeWrite(
  response: WriteResponse,
  interpret: (body: unknown) => Outcome,
): Outcome {
  // Amazon refused with 429 before the skill was called, so nothing ran.
  if (response.status === 'not_dispatched' || response.status === 'rate_limited') return { status: 'not_dispatched' };
  if (response.status === 'unknown') return { status: 'unknown' };
  return interpret(response.body);
}

export function verified(outcome: Outcome, source: string, at: Date): Outcome {
  return { ...outcome, status: 'verified', verification: { source, at: at.toISOString() } };
}
