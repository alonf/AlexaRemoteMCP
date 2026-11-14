# live-test-governance Specification

## Purpose
Defines owner authorization, secret handling and privacy rules that gate every live Amazon interaction during the proof.

## Requirements

### Requirement: Owner approval before live actions
Any live Amazon call SHALL require a recorded owner approval naming the probe, targets, parameters and time window, given by the owner outside model conversation; a model-supplied flag MUST NOT count (SEC-05, §12).

#### Scenario: Approval present
- **WHEN** a probe matches a current approval exactly
- **THEN** it may run within the window

#### Scenario: Approval missing, expired or mismatched
- **WHEN** approval is absent, expired or covers different targets
- **THEN** the probe does not run and reports `not_dispatched`

#### Scenario: Authentication or preflight without approval
- **WHEN** initialization, refresh, login or an authentication preflight lacks matching current owner approval
- **THEN** no Amazon call is dispatched and no login proxy starts

#### Scenario: Authentication guard unavailable
- **WHEN** the authentication guard is missing or incompatible
- **THEN** live authentication and setup fail closed even if an approval exists

### Requirement: Automated tests need no account
Automated unit, contract and fault-injection tests SHALL run without credentials or network access to Amazon, and live tests MUST be opt-in and never run by CI or untrusted forks (OSS-05).

#### Scenario: CI run
- **WHEN** automated tests run in CI
- **THEN** no live call is attempted

### Requirement: Safe secret handling
Secrets SHALL live only in the protected credential store, be git-ignored, and be redacted from logs, errors, screenshots and evidence; secret scanning MUST pass before any commit (SEC-06, SEC-09).

#### Scenario: Secret in output
- **WHEN** a scan finds credential-like content in a log or evidence file
- **THEN** the check fails and the content is removed

### Requirement: Sanitized evidence
Evidence SHALL use synthetic labels, never real names, locations, routine contents, transcripts or account identifiers (SEC-06, OSS-06).

#### Scenario: Evidence review
- **WHEN** evidence is prepared for the repository
- **THEN** a review confirms no private household data is included

### Requirement: Excluded actions
The proof MUST NOT perform purchases, payments, account security changes, emergency actions, or actions on locks, thermostats, doors or security systems (§5.2).

#### Scenario: Excluded target requested
- **WHEN** a probe targets an excluded device class
- **THEN** it is rejected before dispatch

### Requirement: Test success claimed only with evidence
Planning and status documents SHALL record a live test as passed only when the evidence record shows it.

#### Scenario: No evidence
- **WHEN** no evidence record exists for a probe
- **THEN** the probe is reported as not performed
