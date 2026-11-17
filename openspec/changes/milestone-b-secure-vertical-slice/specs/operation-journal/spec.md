# Spec Delta

## Purpose

Defines the durable operation journal for the service: how mutations are recorded, which outcomes they can report, how same-target ordering works and how restart recovery avoids repeating actions.

## ADDED Requirements

### Requirement: Durable journal in the service
The service SHALL record every mutation in a durable journal before dispatch and update it after the outcome, including operation ID, principal, client, target, arguments hash and times (REL-01, REL-06).

#### Scenario: Normal mutation
- **WHEN** an authorized mutation is dispatched
- **THEN** a record exists before dispatch and is updated with the outcome afterwards

#### Scenario: Journal unavailable
- **WHEN** the record cannot be written before dispatch
- **THEN** the action is not dispatched and the outcome is `not_dispatched`

### Requirement: Honest outcome vocabulary
Results SHALL use the existing outcome states `rejected`, `not_dispatched`, `accepted`, `verified`, `failed`, `partially_applied` and `unknown`, plus `superseded` for an operation overtaken by a newer one on the same target (REL-02, REL-05).

#### Scenario: Accepted without confirmation
- **WHEN** Amazon accepts the request and no independent effect is observed
- **THEN** the outcome is `accepted` and physical execution is not claimed

#### Scenario: Timeout or crash window
- **WHEN** the response is lost or the process stops after dispatch
- **THEN** the outcome is `unknown` and the action is not repeated automatically

### Requirement: Newest command wins per target
Operations on the same target SHALL be ordered, and a stale operation, including any retry or verification step, MUST NOT override a newer one (REL-03).

#### Scenario: Two overlapping commands
- **WHEN** a second command for the same target arrives while the first is in flight
- **THEN** the second is the final intent, and any later step of the first is skipped and recorded as `superseded`

#### Scenario: Different targets
- **WHEN** commands for different targets overlap
- **THEN** they are not delayed by each other

### Requirement: Restart recovery
On start the service SHALL treat every incomplete record as `unknown`, MUST NOT replay it, and SHALL make the result visible to the principal who requested it (REL-06, REL-07).

#### Scenario: Restart after dispatch
- **WHEN** the service restarts with a record that was dispatched and not completed
- **THEN** the record becomes `unknown`, no Amazon call is made for it, and a status query returns it

#### Scenario: Retry request from the client
- **WHEN** a client repeats a non-idempotent mutation with the same operation key
- **THEN** the original record is returned and no second dispatch occurs

### Requirement: Journal privacy and access
Journal entries SHALL be visible only to the principal that created them and MUST NOT contain session material or full request payloads (SEC-05, SEC-06).

#### Scenario: Cross-principal lookup
- **WHEN** a principal asks for another principal's operation
- **THEN** the service reports it as not found
