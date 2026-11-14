# Spec Delta

## Purpose

Defines precise outcome states for probe actions, inspection of retries beneath the adapter, and the rules for the one harmless mutation and one explicit routine, so no action is reported as more certain than the evidence.

## ADDED Requirements

### Requirement: Precise outcome states
Every probe action SHALL report one of `rejected`, `not_dispatched`, `accepted`, `verified`, `failed`, `partially_applied` or `unknown`, with per-target results and the verification source and time when `verified` (REL-01, REL-02, REL-05).

#### Scenario: Callback without error
- **WHEN** Amazon returns success without readback
- **THEN** the outcome is `accepted`, not `verified`, and physical execution is not claimed

#### Scenario: Readback confirms
- **WHEN** a subsequent read shows the desired value
- **THEN** the outcome is `verified` with source and timestamp

#### Scenario: Timeout after dispatch
- **WHEN** the request times out after it may have been sent
- **THEN** the outcome is `unknown` and the action is not automatically repeated

### Requirement: Nested retry inspection
Before any live write, the pinned library and helper versions SHALL be inspected, and tested where possible, for automatic retries, re-authentication and error handling beneath the adapter; unsafe write retries MUST be disabled or safely patched (REL-03, REL-04).

#### Scenario: Retry found on a write path
- **WHEN** the library can resend a write internally
- **THEN** the finding is recorded and the write probe stays blocked until the retry is disabled or proven safe

#### Scenario: Fault injection
- **WHEN** a simulated transport failure follows a simulated dispatch
- **THEN** a test proves the write was attempted at most once and the outcome is `unknown`

### Requirement: Persist before and after dispatch
Each live mutation SHALL be recorded locally with operation ID, arguments hash, targets and dispatch time before dispatch and updated after its outcome, and recovery after a crash MUST treat an incomplete record as `unknown` (REL-01, REL-06).

#### Scenario: Crash between dispatch and record
- **WHEN** a restart finds a dispatched record without outcome
- **THEN** it is reported `unknown` and not replayed

### Requirement: One harmless mutation
The harness SHALL perform at most one owner-approved, low-impact, reversible mutation on an owner-designated device, never safety-relevant devices, purchases or account changes (§5.2).

#### Scenario: Approved harmless action
- **GIVEN** the owner approved the exact device and parameters
- **WHEN** the probe runs
- **THEN** the outcome is reported with the precise state and the change is reverted or left as approved

#### Scenario: No approval
- **WHEN** no matching approval exists
- **THEN** the outcome is `not_dispatched`

### Requirement: Explicit routine execution by ID
The routine probe SHALL execute a single owner-designated saved routine by stable ID after the owner reviews its definition, and MUST NOT use a natural-language command as proof it ran (PLUS-02, §5.2).

#### Scenario: Routine executed
- **WHEN** the approved routine ID is run
- **THEN** the outcome is `accepted` unless an independent effect is observed, and the definition hash is recorded

#### Scenario: Definition cannot be inspected
- **WHEN** the routine definition cannot be read adequately
- **THEN** the probe does not run and reports the reason

### Requirement: Compatible adapter signatures
Adapter calls SHALL match the pinned library's actual method signatures, verified by contract tests against the pinned version (acceptance 5).

#### Scenario: Signature drift
- **WHEN** the pinned library signature differs from the adapter
- **THEN** the contract test fails before any live probe
