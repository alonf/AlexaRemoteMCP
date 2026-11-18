# Spec Delta

## Purpose

Requires the owner's own approval, obtained through the MCP Multi Round-Trip Requests pattern, before an action in `approve` mode is dispatched.

## ADDED Requirements

### Requirement: Approval through MRTR
For a call in `approve` mode that carries no valid approval, the server SHALL NOT dispatch. It SHALL return an incomplete result containing an elicitation input request that names the device, the action and the value, plus signed request state, and SHALL end the call (SEC-05).

#### Scenario: First call needs approval
- **WHEN** a client calls a device action whose category is in `approve` mode
- **THEN** the server returns an input-required result with an elicitation request and request state, and no Amazon write occurs

#### Scenario: Owner accepts
- **WHEN** the client retries with the elicitation accepted and the original request state
- **THEN** the server verifies them, dispatches once, journals the outcome and returns it

#### Scenario: Owner declines or cancels
- **WHEN** the elicitation result is `decline` or `cancel`
- **THEN** the call is `rejected` with reason `owner_declined` and nothing is dispatched

### Requirement: Approval cannot be forged or replayed
Request state SHALL be signed by the server, bound to the authenticated owner, device, action, value and an expiry, and SHALL be single use. A model-supplied flag such as `confirmed: true` MUST NOT count as approval (SEC-05).

#### Scenario: Tampered state
- **WHEN** the retry changes the device, action or value, or alters the state
- **THEN** the call is `rejected` and a fresh approval is required

#### Scenario: Expired or reused state
- **WHEN** the state is past its expiry or was already used
- **THEN** the call is `rejected` and nothing is dispatched

#### Scenario: Different user
- **WHEN** the retry is made by a different authenticated subject than the first call
- **THEN** the call is `rejected`

#### Scenario: Model-asserted confirmation
- **WHEN** the tool input claims confirmation but no valid elicitation result accompanies it
- **THEN** the server returns the input-required result again

### Requirement: No elicitation capability, no approval
The server MUST NOT send an input request the client has not declared support for. A client without elicitation support SHALL receive `rejected` with reason `approval_unsupported` for `approve` mode actions, and `allow` mode actions MUST be unaffected.

#### Scenario: Client cannot elicit
- **WHEN** a client that did not declare elicitation calls an `approve` mode action
- **THEN** the call is `rejected` with `approval_unsupported` and nothing is dispatched

### Requirement: Approval evidence in the journal
The journal SHALL record that an approval was requested, and whether it was granted, declined, expired or invalid, linked to the operation, without storing the signed state.

#### Scenario: Granted approval
- **WHEN** an approved action is dispatched
- **THEN** the journal entry shows the approval decision and its time

### Requirement: Uncertain outcomes are not retried automatically
An approved action whose dispatch outcome is uncertain SHALL be reported as such and MUST NOT be re-dispatched without a new approval (CAP-04).

#### Scenario: Uncertain write
- **WHEN** an approved write returns an uncertain result
- **THEN** the reply says so and a new call needs a new approval
