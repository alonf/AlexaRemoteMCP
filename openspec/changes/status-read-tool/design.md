## Context

Approvals are rows in the journal `approvals` table with a decision of `requested` until decided. The signed request state is never stored, only its nonce. Lifetime is `APPROVAL_TTL_MS` (2 minutes).

## Decisions

**D1: Read-only and incapable of approving.** Only operation kind and timings are returned; the nonce and the signed state never leave the server, so a woken agent can describe the wait but not complete it.

**D2: Caller only.** The query filters on the caller's principal.

**D3: Time-bounded in the query.** Rows older than the lifetime are excluded by timestamp; no cleanup job is needed.

**D4: No summary text.** The summary is not stored (it can name a device), so none is returned; the doorbell payload already carried it.
