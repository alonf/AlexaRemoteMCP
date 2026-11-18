## ADDED Requirements

### Requirement: Status tool
The server SHALL provide a read-only `get_status` tool requiring the read scope that returns the Alexa session health and the caller's pending approvals. A pending approval is one requested by the same principal, not yet decided and not older than the approval lifetime. Each entry SHALL contain only the operation kind, seconds since requested and seconds until expiry.

#### Scenario: Pending approval listed
- **WHEN** an approval was requested a minute ago by the caller and is undecided
- **THEN** `get_status` lists it with about 60 seconds remaining

#### Scenario: Decided or expired approvals hidden
- **WHEN** an approval was granted, declined, or is older than 2 minutes
- **THEN** it is not listed

#### Scenario: Other principals hidden
- **WHEN** another principal has a pending approval
- **THEN** it is not listed

### Requirement: Nothing to approve with
The response SHALL NOT include nonces, approval ids, request state, device identifiers or the text of any approval.

#### Scenario: Safe payload
- **WHEN** approvals are pending
- **THEN** the response contains no value that could be replayed to approve or identify a device
