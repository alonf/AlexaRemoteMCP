## ADDED Requirements

### Requirement: Owner-listed urgent reasons
The server SHALL accept an optional `reason` on `speak`. If `reason` exactly matches a value in `SPEAK_URGENT_REASONS` and speech is not off, the approval step SHALL be skipped. If the list is empty, or the reason is absent or not listed, the normal speech policy SHALL apply and the call SHALL NOT be rejected for the reason alone.

#### Scenario: Listed reason skips approval
- **WHEN** speech is set to `approve`, the reason is listed and the target is allowed and online
- **THEN** the text is announced without an approval request

#### Scenario: Unlisted reason
- **WHEN** the reason is not in the list
- **THEN** the call follows the normal approval path

#### Scenario: Bypass off by default
- **WHEN** `SPEAK_URGENT_REASONS` is empty
- **THEN** every reason is treated as unlisted

### Requirement: Same checks as ordinary speech
An urgent announcement SHALL still be refused for disallowed or unknown devices (identically), offline devices, invalid text and when speech is off.

#### Scenario: Disallowed device
- **WHEN** an urgent call names a device outside `SPEAK_TARGETS`
- **THEN** it is refused and nothing is spoken

### Requirement: Separate tight limit
The server SHALL refuse more than `SPEAK_URGENT_LIMIT` (default 2) urgent announcements in 10 minutes. These count separately from ordinary speech; a call over the urgent limit SHALL NOT fall back to speaking without approval.

#### Scenario: Limit reached
- **WHEN** the urgent limit is reached
- **THEN** the call is refused with a rate-limit reason and nothing is spoken

### Requirement: Always notify the owner
Each urgent announcement SHALL publish a `speech.urgent` event with the reason and no text, device name or identifier. The journal SHALL record the reason, target count, digest and outcome, never the text.

#### Scenario: Doorbell rings
- **WHEN** an urgent announcement is sent
- **THEN** subscribers receive `speech.urgent` with the reason only
