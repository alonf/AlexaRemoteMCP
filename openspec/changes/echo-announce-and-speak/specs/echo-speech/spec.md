## ADDED Requirements

### Requirement: Speaker discovery
The server SHALL provide a read-only `list_speakers` tool returning, for each Echo device the agent is allowed to speak on, a display name, whether it is online and whether it can speak. It SHALL NOT return serial numbers, account identifiers or other devices.

#### Scenario: Allowed speakers listed
- **WHEN** a client with the read scope calls `list_speakers`
- **THEN** only devices matching the configured speaking targets are returned, without serial numbers

#### Scenario: Speech turned off
- **WHEN** speech is off
- **THEN** the tool returns no speakers and `speak` is not offered

### Requirement: Speaking a short text
The server SHALL provide a `speak` tool that says a plain text on one named allowed Echo (`mode` speak) or announces it on one or more allowed Echo devices (`mode` announce). The text SHALL be plain text of at most 250 characters with control characters removed; SSML or markup SHALL be refused. The tool SHALL require the mutate scope.

#### Scenario: Spoken on one device
- **WHEN** an approved `speak` names an allowed, online Echo
- **THEN** the text is spoken there once and the reply reports the outcome

#### Scenario: Target not allowed
- **WHEN** the named device is not an allowed target or does not exist
- **THEN** the request is refused, nothing is spoken and the reply does not reveal whether the device exists

#### Scenario: Bad text
- **WHEN** the text is empty, longer than 250 characters, or contains SSML or markup
- **THEN** the request is refused and nothing is spoken

#### Scenario: Offline device
- **WHEN** the target is offline
- **THEN** the request is refused with an offline reason and nothing is spoken

### Requirement: Approval before speaking
Unless the owner has set speech to `allow`, every spoken text SHALL pass the approval gate shown for device actions, displaying the exact text and target, with the chat-confirmation fallback for clients that cannot ask. An approval SHALL be single-use, bound to the text, mode and targets, and SHALL expire after 2 minutes. Asking SHALL ring the `approval.requested` doorbell like other approvals.

#### Scenario: Approval required
- **WHEN** `speak` is called with speech set to `approve`
- **THEN** nothing is spoken until the owner approves the exact text and target

#### Scenario: Changed text after approval
- **WHEN** a repeat call changes the text, mode or targets
- **THEN** the old approval is refused and nothing is spoken

#### Scenario: Owner declines
- **WHEN** the owner declines
- **THEN** nothing is spoken

### Requirement: Limits and record
The server SHALL refuse more than 5 spoken texts in 10 minutes in total. Each attempt SHALL be journaled with its outcome, target count and a digest of its arguments; the journal and the logs SHALL NOT hold the text, serial numbers or device names.

#### Scenario: Rate limit
- **WHEN** a sixth request arrives within 10 minutes of five accepted ones
- **THEN** it is refused with a rate-limit reason and nothing is spoken

#### Scenario: No text in records
- **WHEN** a text is spoken
- **THEN** the journal row and the log line contain no part of the text and no device identifier

### Requirement: Honest outcomes
When the upstream call is accepted but its effect cannot be confirmed, the reply SHALL say `accepted` and SHALL NOT claim the text was heard. A refused or failed call SHALL be reported as such.

#### Scenario: Upstream refuses
- **WHEN** Alexa refuses the call
- **THEN** the reply reports a failure and the journal records it as not delivered
