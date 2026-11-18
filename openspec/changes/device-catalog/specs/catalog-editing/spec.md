# Spec Delta

## Purpose

Lets an agent read and edit the catalog through MCP only with owner approval, and lets the owner draft a catalog from the KNX gateway list.

## ADDED Requirements

### Requirement: Catalog read tool
The service SHALL expose a tool that returns the catalog entries to authorized clients.

#### Scenario: Read
- **WHEN** an authorized client calls it
- **THEN** it receives the current entries and the permission group definitions

### Requirement: Approval-gated edits
Any catalog change through MCP SHALL require owner approval through MRTR, with a server-built message listing the exact changes. A client that cannot elicit MUST be refused. The signed state MUST be bound to the user and the exact change set and be single use. Edits MUST be validated like startup input and journaled without the signed state.

#### Scenario: Approved edit
- **WHEN** the owner accepts the prompt for the exact change set
- **THEN** the catalog is saved and the next call uses it

#### Scenario: Declined or unsupported
- **WHEN** the owner declines, or the client cannot elicit
- **THEN** nothing is saved

#### Scenario: Changed payload
- **WHEN** the retry carries a different change set than the one approved
- **THEN** it is rejected

### Requirement: Draft script
A local script SHALL draft a catalog from the Alexa inventory and a KNX gateway device list by matching names, mark unmatched devices for review, and write only to a git-ignored path.

#### Scenario: Unmatched device
- **WHEN** an Alexa device has no KNX match
- **THEN** it is listed for review with category `other` and no group
