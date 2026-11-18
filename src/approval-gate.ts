import { type ApprovalSigner, approvalInputRequest, digestOf, readApprovalResponse } from './approval.js';
import type { OperationContext, SqliteJournal } from './sqlite-journal.js';

export type ApprovalRefusal = 'approval_unsupported' | 'owner_declined' | 'approval_invalid' | 'approval_expired' | 'confirmation_too_soon';

// A confirmation cannot come back faster than a person could answer a question.
export const MIN_CONFIRMATION_DELAY_MS = 3000;

// What the client sent on this call: whether it can answer an elicitation, the retry fields of an MRTR round trip,
// and the spoken-confirmation fallback fields for clients that cannot elicit.
export interface ApprovalInput {
  canElicit: boolean;
  requestState?: unknown;
  inputResponses?: unknown;
  confirmation?: { approvalId?: unknown; confirmed?: unknown };
}

export type GateReply =
  | { status: 'rejected'; reason: ApprovalRefusal }
  | { status: 'not_dispatched' }
  | { status: 'approval_required'; approval: { inputRequests: Record<string, unknown>; requestState: string } }
  | { status: 'confirmation_required'; question: string; approvalId: string; instructions: string };

export interface GateDeps {
  signer: ApprovalSigner | undefined;
  journal: SqliteJournal;
  now: () => Date;
}

// Returns the nonce of a consumed approval, or the reply to send instead of acting. Shared by device writes and catalog edits.
// `allowSpoken` lets a model-relayed confirmation (typed or spoken in chat) stand in when the client cannot elicit.
export async function gateApproval(
  deps: GateDeps,
  context: OperationContext,
  targetId: string,
  operation: string,
  parameters: unknown,
  summary: string,
  approval: ApprovalInput,
  allowSpoken = false,
): Promise<{ nonce: string } | GateReply> {
  const { signer, journal } = deps;
  if (!signer) return { status: 'rejected', reason: 'approval_unsupported' };
  const at = deps.now();
  const binding = { subject: context.principal, targetId, request: digestOf({ operation, parameters }) };
  const spoken = !approval.canElicit && allowSpoken;

  const ask = (): GateReply => {
    if (!approval.canElicit && !spoken) return { status: 'rejected', reason: 'approval_unsupported' };
    const issued = signer.issue(binding, at);
    try {
      journal.requestApproval(issued.nonce, context, operation, targetId, at);
    } catch {
      return { status: 'not_dispatched' };
    }
    if (spoken) {
      return {
        status: 'confirmation_required',
        question: `${summary[0]?.toUpperCase()}${summary.slice(1)}? Please confirm.`,
        approvalId: issued.state,
        instructions: 'Nothing has been done yet. Ask the user this question and wait for their own answer. Only if they clearly say yes, repeat this exact call with approvalId and confirmed=true. If they say no, repeat it with confirmed=false. Never confirm on the user\'s behalf. The approvalId works once and expires in 2 minutes.',
      };
    }
    return {
      status: 'approval_required',
      approval: { inputRequests: approvalInputRequest(`Approve: ${summary}? Expires in 2 minutes.`), requestState: issued.state },
    };
  };

  const state = spoken ? approval.confirmation?.approvalId : approval.requestState;
  if (state === undefined) return ask();
  const verdict = signer.verify(state, binding, at);
  try {
    if (!verdict.ok) {
      if (verdict.nonce === undefined || !journal.decideApproval(verdict.nonce, verdict.reason === 'approval_expired' ? 'expired' : 'invalid', at)) {
        journal.noteApproval(context, operation, targetId, 'invalid', at);
      }
      return { status: 'rejected', reason: verdict.reason };
    }
    const answer = spoken
      ? (approval.confirmation?.confirmed === true ? 'accepted' : approval.confirmation?.confirmed === false ? 'declined' : 'missing')
      : readApprovalResponse(approval.inputResponses);
    if (answer === 'missing') return ask();
    if (answer === 'declined') {
      journal.decideApproval(verdict.nonce, 'declined', at);
      return { status: 'rejected', reason: 'owner_declined' };
    }
    // Too fast to be a person: refuse without consuming, so a real answer can still follow.
    if (spoken && at.getTime() - verdict.issuedAt < MIN_CONFIRMATION_DELAY_MS) return { status: 'rejected', reason: 'confirmation_too_soon' };
    // Single use: only the first accept of a requested nonce is granted.
    if (!journal.decideApproval(verdict.nonce, 'granted', at)) return { status: 'rejected', reason: 'approval_invalid' };
    return { nonce: verdict.nonce };
  } catch {
    return { status: 'not_dispatched' };
  }
}
