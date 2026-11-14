# Spec Delta

## Purpose

Defines how the proof harness signs the owner in to Amazon, persists session material protected from disclosure, and reports session health without looping or leaking credentials.

## ADDED Requirements

### Requirement: Owner-interactive sign-in
The harness SHALL obtain an Amazon session only through the upstream library's supported interactive registration flow, completed by the owner directly; passwords, MFA codes and CAPTCHA answers MUST NOT pass through MCP tools, chat, logs or automation (AUTH-01, AUTH-02, SEC-01).

#### Scenario: Owner completes sign-in
- **GIVEN** the owner has approved a live session for a stated time window
- **WHEN** the owner starts the setup flow on the local machine
- **THEN** a loopback-only login interface is available only during that window and a session is stored on success

#### Scenario: Setup window expires
- **WHEN** the time limit elapses without completed sign-in
- **THEN** the login interface stops listening and no session is stored

#### Scenario: Delayed proxy startup or callback
- **WHEN** setup expires or is cancelled before the helper starts its proxy or finishes its callback
- **THEN** no proxy starts or remains listening and no late callback stores a session

### Requirement: Protected atomic persistence
The harness SHALL persist all session data the library needs for refresh atomically, outside version control, with owner-only filesystem permissions, and SHALL treat the whole file as highly sensitive (AUTH-03, SEC-06).

#### Scenario: Successful refresh is persisted
- **WHEN** the library emits refreshed session data
- **THEN** the stored session is replaced atomically and a redacted refresh event is recorded

#### Scenario: Write failure
- **WHEN** persisting session data fails
- **THEN** the harness reports a persistence failure, does not claim healthy persistence, and retains the previous valid session file

#### Scenario: Secrets absent from outputs
- **WHEN** logs, errors, evidence files and test fixtures are scanned
- **THEN** they contain no cookies, tokens, signing material or account identifiers

### Requirement: Single refresh owner
Exactly one session manager SHALL own initialization and refresh; concurrent callers MUST join the in-flight operation (AUTH-04, ARCH-01).

#### Scenario: Concurrent initialization
- **WHEN** several callers request a session simultaneously
- **THEN** one initialization or refresh occurs and all callers receive its result

#### Scenario: Upstream automatic behavior
- **WHEN** the session manager initializes or refreshes using the pinned library
- **THEN** the upstream refresh timer and implicit login or reinitialization fallback are disabled, and only the session manager owns those operations

### Requirement: Session health states
The harness SHALL expose distinct states including usable, `reauthentication_required` and persistence-failed, and MUST NOT retry sign-in in a loop after expiry or revocation (AUTH-04, REL-08).

#### Scenario: Revoked or expired session
- **WHEN** Amazon rejects the stored session
- **THEN** the state becomes `reauthentication_required` and no further automatic sign-in attempts occur

#### Scenario: Refresh or authentication failure
- **WHEN** refresh fails, authentication is rejected, or the authentication check encounters a network failure
- **THEN** the harness does not implicitly start login or retry initialization, and reports the appropriate failure without exposing session material

#### Scenario: Authentication guard missing
- **WHEN** the pinned authentication guard is missing or incompatible
- **THEN** initialization, refresh and setup fail closed before any Amazon call or proxy startup

#### Scenario: Restart with stored session
- **WHEN** the harness restarts with a valid stored session
- **THEN** it resumes without interactive sign-in

### Requirement: Local credential removal
The harness SHALL provide explicit logout that deletes local credential material and does not claim to revoke the Amazon-side session unless that was verified (AUTH-04).

#### Scenario: Logout
- **WHEN** the owner requests logout
- **THEN** local session data is removed and the state returns to unauthenticated
