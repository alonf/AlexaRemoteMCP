# Roadmap: Alexa Remote MCP

Planning map from REQUIREMENTS.md (v0.1, unchanged and authoritative) to OpenSpec changes. It retains the **full single-instance MVP scope**; Milestone A is only the first risk-reduction step. No item here is implemented or verified, and no real-account test has passed. Capability families remain proposed until runtime evidence exists (CAP-03, CAP-04).

## Milestones

| Milestone | Status | Change |
|---|---|---|
| A: Connectivity proof (no public claims) | Planned | `establish-alexa-connectivity-proof` |
| B: Secure vertical slice | Candidate | see B1–B4 |
| C: Functional completeness | Candidate | see C1–C9 |
| D: Public single-instance MVP | Candidate | see D1–D4 |
| E: Optional future HA | Out of MVP, deferred | §14; separate design only after stable single instance |

Milestone A gate: written go/no-go; B does not start while an auth, retry or compatibility blocker is open.

## Milestone A: `establish-alexa-connectivity-proof`

Covers §12 Milestone A; AUTH-01..05; SEC-01, SEC-06; REL-02..04, 06, 07; TEMP-02, 05, 07; PLUS-01..05; §15 decisions; acceptance 2 (partial), 3 (partial), 5 (signature). Specs: amazon-session-persistence, alexa-read-probes, alexa-action-outcomes, dnd-probe-recovery, alexa-plus-compatibility-evidence, live-test-governance.

## Milestone B candidates: secure vertical slice

| Change candidate | Requirements |
|---|---|
| B1 `native-streamable-http-mcp` | MCP-01..06, ARCH-01..03, acceptance 1 (partial) |
| B2 `mcp-authorization-and-ingress` | SEC-01..05, DEP-05, acceptance 10 (partial) |
| B3 `operation-journal-and-restart` | ARCH-04..06, REL-01, REL-06, REL-08 |
| B4 `read-inventory-and-one-controlled-mutation` | §5 Discovery/State/Operations families (read-only slice), example client, MCP-06 |

## Milestone C candidates: functional completeness

| Change candidate | Requirements / §5 families |
|---|---|
| C1 `capability-ledger` | CAP-01..04, acceptance 13; every public method and variant of the pinned library classified |
| C2 `smart-home-state-and-control` | State, Direct smart-home control; §5.2 safety-device policy; REL-04, REL-05, REL-07 |
| C3 `routines-and-speech` | Routines (allowlist, definition hash), Speech/SSML, Text commands; SEC-08; acceptance 5 |
| C4 `volume-media-and-bluetooth` | Volume and audio, Bluetooth (unpair restricted) |
| C5 `temporary-dnd-and-settings` | DND, Device settings, TEMP-01..07; acceptance 6 |
| C6 `lists-and-notifications` | Lists, Notifications (alarms/reminders restricted); acceptance 7 |
| C7 `groups-and-device-management` | Group management with preview, Device management (removal disabled by default), Account metadata, Skills/catalogs |
| C8 `restricted-optional-capabilities` | History/cards, Communications, Upstream events; SEC-07; PLUS-04; acceptance 9 |
| C9 `high-risk-approval-and-privacy-policy` | SEC-04..07, per-principal/target/risk policy, operator approval path; acceptance 4, 10 |

Every excluded or deferred end-user capability needs a documented reason and scope decision (§2, CAP-04). Comparator coverage (S1: inventory, announcement, text command, volume, routines, lists, single-device DND, state query, SSML, group create/update/delete) is mapped by C2–C7 and checked in C1.

## Milestone D candidates: public single-instance MVP

| Change candidate | Requirements |
|---|---|
| D1 `deployment-docker-and-native` | DEP-01..07; acceptance 11, 12; backup/restore on replacement host |
| D2 `security-review-and-supply-chain` | SEC-09, OSS-05; threat model, SBOM, secret scanning; acceptance 10, 14 |
| D3 `compatibility-matrix-and-docs` | OSS-01, 06, 07, PLUS-05, §2 dated matrix; license decision OSS-02; unofficial notice OSS-03 |
| D4 `release-acceptance` | Acceptance 1–14, clean install, package/image checks, tag whose claims match evidence |

## Requirement traceability

| Source | Mapped to |
|---|---|
| §1 Product, non-goals | Whole roadmap; non-goals apply to all changes |
| §2 Evidence/limitations | A, C1, D3 |
| §3 Users/use cases | B4, C2, C5, C6 |
| §4.1 ARCH-01..06 | B1, B3 |
| §4.2 MCP-01..06 | B1, B4 |
| §5 families and §5.1 CAP | C1–C8; discovery/state slice in B4 |
| §5.2 restrictions | A (excluded targets), C2, C3, C9 |
| §6 TEMP-01..07 | A (probe), C5 |
| §7 SEC, AUTH | A (AUTH), B2, C9, D2 |
| §8 REL-01..08 | A (02–04, 06, 07), B3, C2 |
| §9 PLUS-01..05 | A, C8 (events), D3 |
| §10 DEP-01..07 | D1 |
| §11 OSS-01..07 | D2, D3 |
| §12 risk gates | A, B, C, D milestones |
| §13 acceptance 1–14 | Distributed as noted; all verified in D4 |
| §14 Future HA | Milestone E; only interfaces `AlexaAdapter`, `OperationStore`, `CredentialStore`, `CommandExecutor`, `Scheduler`, `EventSource` prepared |
| §15 decisions | A resolves; remaining carried by B/C/D |

## Sequencing notes

- Later changes are proposed with `openspec-propose` only after the prior milestone's evidence and decision exist.
- Live-account work always requires owner approval and sanitized evidence.
- Do not claim support, publish compatibility, or ship a release before D4 evidence exists.
