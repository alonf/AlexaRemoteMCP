# Tasks

Checked items are complete; unchecked items remain open. Live tasks require explicit owner approval and MUST NOT be run by an agent without it.

## 1. Project foundation (automated)

- [x] 1.1 Initialize strict TypeScript/Node project, lockfile, lint, test runner; select supported Node LTS (§15, DEP-02)
- [x] 1.2 Add `.gitignore` entries for credential, approval, and local mapping files; add secret scanning (SEC-09)
- [x] 1.3 Review current alexa-remote2 and cookie-helper releases and pin exact versions with rationale; record license review (§15, OSS-02)
- [x] 1.4 Add redacting logger and tests proving cookies, tokens and identifiers never appear (SEC-06)

## 2. Retry and error inspection (automated)

- [x] 2.1 Read pinned library source for retries, re-login and error handling on each method to be probed; document findings (REL-03)
- [x] 2.2 Build local fake endpoint and fault-injection tests counting dispatches per write for timeout, reset, 5xx, 401 (REL-03, REL-04)
- [x] 2.3 Disable or patch unsafe write retries; test at most one dispatch and outcome `unknown` after post-dispatch failure
- [x] 2.4 Contract tests for adapter signatures against the pinned library (acceptance 5)

## 3. Session manager (automated)

- [x] 3.1 Implement atomic protected credential store with permission checks; test write failure retains old file (AUTH-03)
- [x] 3.1a Patch and verify the pinned authentication lifecycle to suppress implicit login/reinitialization and the upstream refresh timer; fail closed if the guard is absent, with offline refresh-failure, rejection and network-error tests (AUTH-02, AUTH-04)
- [x] 3.2 Integrate the pinned session backend with the single-owner manager; test concurrent initialization, refresh and setup callers join the in-flight operation (AUTH-04)
- [x] 3.3 Implement health states, actual authentication-rejection handling as `reauthentication_required` without a loop, persistence failure, and local logout including in-flight coordination (AUTH-04)
- [x] 3.4 Implement owner-approved loopback-only time-limited login setup; test non-loopback refusal, expiry, cancellation and delayed startup/callback without persistence (AUTH-02)

## 4. Outcomes, journal and approvals (automated)

- [x] 4.1 Implement outcome vocabulary and normalizers for non-2xx, empty, malformed, per-device failures (REL-02, REL-03)
- [x] 4.2 Implement pre/post-dispatch journal; crash-recovery test yields `unknown` and no replay (REL-06)
- [x] 4.3 Implement local owner-approval file check; tests for missing, expired, mismatched approvals (SEC-05)
- [x] 4.4 Implement excluded-device-class rejection (§5.2)
- [x] 4.5 Implement evidence sanitizer with synthetic labels and tests

## 5. Probes (automated parts)

- [x] 5.1 Read probes for inventory and one state with freshness and unknown handling, tested with fixtures (REL-07)
- [x] 5.2 DND snapshot/restore logic with fake backend: started-enabled, manual change, partial failure, restart, snapshot write failure (TEMP-02..07)
- [x] 5.3 Routine-by-ID probe with definition-hash and inspection-failure tests (PLUS-02)

## 6. Owner-approved live validation (manual; do not run without approval)

- [x] 6.1 Owner states region, locale, devices, Alexa+ status and allowed actions; record approvals
- [x] 6.2 Interactive sign-in by owner; verify protected persistence
- [x] 6.3 Restart and refresh behavior; expiry or revocation handling if safely observable
- [x] 6.4 Live read of inventories and one state read
- [x] 6.5 Live DND read
- [x] 6.6 One harmless approved mutation with readback or `accepted` outcome
- [x] 6.7 One approved explicit routine execution
- [x] 6.8 DND write and recovery on approved device, plus native duration observation (duration not observed; see evidence)
- [ ] 6.9 Optional: event connection observation (PLUS-04)

## 7. Evidence and decision

- [x] 7.1 Write sanitized dated evidence with per-operation status, including untested items (PLUS-05; docs/live-evidence-2026-11-14.md)
- [x] 7.2 Run secret scan and privacy review of every artifact before any commit
- [x] 7.3 Record resolutions of §15 decisions and go/no-go with blockers for Milestone B
- [x] 7.4 Confirm README and requirements wording makes no support claim
- [x] 7.5 Test DND away-and-back manual changes without revision history; uncertainty must not trigger an unsafe automatic restoration (TEMP-05)
