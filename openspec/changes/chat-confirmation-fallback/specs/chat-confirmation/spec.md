# Spec Delta

## Purpose

Lets the user approve an action in the conversation when the client cannot show an approval prompt.

## ADDED Requirements

### Requirement: Ask before acting
When an approval-mode device action comes from a client that cannot elicit and chat confirmation is enabled, the server SHALL return `confirmation_required` with a question it wrote itself and a signed `approvalId`, and MUST NOT dispatch anything.

#### Scenario: First call
- **WHEN** such a client requests an approval-mode action
- **THEN** the reply is `confirmation_required` and no write is sent

#### Scenario: Disabled
- **WHEN** `CHAT_CONFIRMATION` is `off`
- **THEN** the client is refused with `approval_unsupported`

### Requirement: Bounded confirmation
The `approvalId` MUST be single-use, expire after 2 minutes, and bind the principal, device, operation and parameters. A repeat call with `confirmed=true` SHALL dispatch once. `confirmed=false` SHALL decline. A confirmation less than 3 seconds after the ask SHALL be refused with `confirmation_too_soon` without consuming the id.

#### Scenario: Confirm
- **WHEN** the call is repeated with the id and `confirmed=true` after the minimum delay
- **THEN** the action is dispatched once and the id cannot be reused

#### Scenario: Wrong target, expired or declined
- **WHEN** the id is used for another device, has expired, or `confirmed` is false
- **THEN** nothing is dispatched

### Requirement: Real elicitation unchanged
A client that can elicit SHALL keep using the MRTR flow. Catalog edits SHALL NOT accept chat confirmation.

#### Scenario: Catalog edit from a non-eliciting client
- **WHEN** such a client edits the catalog
- **THEN** it is refused with `approval_unsupported`
