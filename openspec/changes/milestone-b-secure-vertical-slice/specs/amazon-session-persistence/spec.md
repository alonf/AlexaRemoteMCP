# Spec Delta

## MODIFIED Requirements

### Requirement: Protected atomic persistence
The harness SHALL persist all session data the library needs for refresh atomically, outside version control, behind a store interface whose local implementation uses owner-only filesystem permissions and whose cloud implementation uses a managed secret store, and SHALL treat the whole session as highly sensitive (AUTH-03, SEC-06).

#### Scenario: Successful refresh is persisted
- **WHEN** the library emits refreshed session data
- **THEN** the stored session is replaced atomically and a redacted refresh event is recorded

#### Scenario: Write failure
- **WHEN** persisting session data fails
- **THEN** the harness reports a persistence failure, does not claim healthy persistence, and retains the previous valid session

#### Scenario: Secrets absent from outputs
- **WHEN** logs, errors, evidence files and test fixtures are scanned
- **THEN** they contain no cookies, tokens, signing material or account identifiers

#### Scenario: Cloud store selected
- **WHEN** the service runs in the cloud deployment
- **THEN** the session is read from and written to the managed secret store, and no session file is written to the instance disk

#### Scenario: Session seeded from the owner's machine
- **WHEN** the owner completes sign-in locally and approves seeding the cloud store
- **THEN** the session moves to the secret store without appearing in logs, chat or the repository, and the local copy is removed or kept only by the owner's choice
