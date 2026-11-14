# Proposal

## Why

The MVP depends on unofficial Amazon interfaces reached through alexa-remote2. Sign-in stability, session persistence, upstream retry behavior and Alexa+ compatibility are the largest unverified risks (REQUIREMENTS.md §12 risk table, §9). They must be resolved by a small, owner-supervised connectivity proof before the broad tool surface, authorization and deployment work are built. Nothing in this repository has been tested against a real account.

## What Changes

This change covers **Milestone A only** (REQUIREMENTS.md §12). It plans a minimal, internal, non-public proof harness and its evidence:

- Interactive owner sign-in using the library's supported flow, with protected atomic session persistence, a single refresh owner, and restart/expiry/failed-write behavior (AUTH-01..05, SEC-06; acceptance 2). Guard the pinned upstream authentication lifecycle against implicit login and unsafe proxy startup.
- Pinning and review of alexa-remote2 and cookie-helper versions, and a static plus fault-injected inspection of nested/upstream retry and error handling beneath the adapter (REL-03, REL-04, §15).
- Read-only inventory (Echo, smart-home, routines), one smart-home state read with freshness/per-item error handling (REL-07; acceptance 3).
- Structured outcome vocabulary applied to every probe (REL-02, REL-05).
- One harmless, owner-approved mutation, one explicit routine execution by ID, and DND read/write/recovery preserving prior values (TEMP-02, TEMP-07, PLUS-01, PLUS-02).
- Alexa+ status determination and a dated, sanitized evidence record with verified/experimental/unsupported entries (PLUS-01, PLUS-05, §2).
- An owner-approval protocol gating every live-account action.
- Recording the §15 engineering decisions that Milestone A resolves.

### Non-goals

- Not the MVP. Milestones B–D (MCP HTTP server, authorization, full capability ledger, deployment, release) are retained in `openspec/ROADMAP.md` and stay in scope for the product; they are deferred, not dropped.
- No public support claim, compatibility certification, release, or HA/Dapr/Kubernetes/Aspire/broker work.
- No implementation in this planning step; no Amazon login, device actions, commit or push now.
- No claim that any real-account test has passed.

## Capabilities

### New Capabilities
- `amazon-session-persistence`: Interactive owner sign-in, protected persistence, single-owner refresh, expiry/revocation/failed-write states, local credential removal.
- `alexa-read-probes`: Pinned-library adapter probes for inventory, routine metadata, one state read, with timestamps, freshness and per-item errors.
- `alexa-action-outcomes`: Structured outcome states, nested-retry inspection and uncertainty rules for writes, including the harmless mutation and explicit routine probes.
- `dnd-probe-recovery`: DND read/write/recovery probe preserving prior state.
- `alexa-plus-compatibility-evidence`: Alexa+ status determination and sanitized dated evidence, with no overclaiming.
- `live-test-governance`: Owner-approved live testing, secret handling and privacy-safe evidence.

### Modified Capabilities
None (no existing specs).

## Impact

- New TypeScript/Node harness code and tests under a future `src/` (during apply only); new dev dependencies alexa-remote2 and a cookie helper, pinned with lockfile.
- A protected local credential file outside version control; secret scanning and `.gitignore` entries.
- Evidence document of sanitized results. Planning artifacts only in this step: `openspec/changes/establish-alexa-connectivity-proof/**` and `openspec/ROADMAP.md`. REQUIREMENTS.md and README.md are unchanged.
