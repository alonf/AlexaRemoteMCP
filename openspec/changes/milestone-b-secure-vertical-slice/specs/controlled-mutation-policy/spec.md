# Spec Delta

## Purpose

Defines the one mutation the slice permits and the action policy that refuses all other device classes by default, so remote clients cannot cause unreviewed physical effects.

## ADDED Requirements

### Requirement: Single permitted mutation
The slice SHALL expose exactly one mutation tool, limited to a low-risk action on an explicitly allow-listed target, and no other mutating tool SHALL be listed (CAP-03, SEC-07).

#### Scenario: Allow-listed target
- **WHEN** an authorized client with the mutation scope targets an allow-listed device
- **THEN** the action is dispatched and its outcome is journaled and returned

#### Scenario: Target not allow-listed
- **WHEN** the target is not on the allow-list
- **THEN** the call is `rejected` before any Amazon call

### Requirement: Safety-relevant classes refused by default
Device classes with safety or damage risk, such as shutters, heaters, air conditioning, locks and gates, SHALL be refused by the policy unless a later change enables them with its own review (SEC-07, CAP-04).

#### Scenario: Restricted class requested
- **WHEN** a call targets a refused class
- **THEN** it is `rejected` with the reason and nothing is dispatched

#### Scenario: Unknown class
- **WHEN** the class of a target cannot be determined
- **THEN** the call is `rejected`, not allowed

### Requirement: Validation before dispatch
Targets, capabilities and values SHALL be validated against the current inventory before dispatch, and unsupported capabilities MUST fail before dispatch (CAP-02).

#### Scenario: Unsupported capability
- **WHEN** a call asks for a capability the device does not declare
- **THEN** the outcome is `rejected` and no Amazon call is made

### Requirement: Live use needs owner approval
Live Alexa actions SHALL occur only in owner-approved windows, and automated tests MUST use a fake adapter with no account (live-test-governance).

#### Scenario: Automated test run
- **WHEN** the automated suite runs
- **THEN** no network call reaches Amazon
