import fs from 'node:fs/promises';
import { hashArguments } from './journal.js';

export interface Approval {
  probe: string;
  targets: string[];
  argumentsHash: string;
  notBefore: string;
  expiresAt: string;
}

export type ApprovalDecision = { approved: true } | { approved: false; reason: 'missing' | 'expired' | 'mismatched' | 'unreadable' };

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

function valid(value: unknown): value is Approval {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.probe === 'string'
    && Array.isArray(v.targets) && v.targets.every((t) => typeof t === 'string')
    && typeof v.argumentsHash === 'string'
    && typeof v.notBefore === 'string' && Number.isFinite(Date.parse(v.notBefore))
    && typeof v.expiresAt === 'string' && Number.isFinite(Date.parse(v.expiresAt));
}

// Approvals come only from an owner-maintained local file; callers cannot pass a flag that substitutes for it.
export async function checkApproval(
  approvalFile: string,
  request: { probe: string; targets: string[]; args: unknown },
  now: Date = new Date(),
): Promise<ApprovalDecision> {
  let approvals: unknown;
  try {
    approvals = JSON.parse(await fs.readFile(approvalFile, 'utf8'));
  } catch (error) {
    return { approved: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  if (!Array.isArray(approvals)) return { approved: false, reason: 'unreadable' };

  const candidates = approvals.filter(valid).filter((a) => a.probe === request.probe);
  if (candidates.length === 0) return { approved: false, reason: 'missing' };
  const hash = hashArguments(request.args);
  const matching = candidates.filter((a) => a.argumentsHash === hash && sameSet(a.targets, request.targets));
  if (matching.length === 0) return { approved: false, reason: 'mismatched' };
  const current = matching.some((a) => Date.parse(a.notBefore) <= now.getTime() && now.getTime() < Date.parse(a.expiresAt));
  return current ? { approved: true } : { approved: false, reason: 'expired' };
}
