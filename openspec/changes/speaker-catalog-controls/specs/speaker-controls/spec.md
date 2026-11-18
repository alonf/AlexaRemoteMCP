## ADDED Requirements

### Requirement: Speakers in the catalog
Each Echo SHALL be represented as a catalog entry carrying a `speaker` object with flags `announce`, `urgent`, `volume` and `features`, all defaulting to off. Speakers not in the catalog SHALL be refused identically to unknown devices.

#### Scenario: New speaker defaults
- **WHEN** a speaker is first discovered
- **THEN** it cannot be spoken to, bypassed or volume-controlled until the owner enables a flag

### Requirement: Announce permission
`speak` and `announce` SHALL be allowed only on speakers whose `announce` flag is on.

#### Scenario: Announce disabled
- **WHEN** the agent speaks on a speaker with `announce` off
- **THEN** the call is refused with the standard target refusal

### Requirement: Urgent bypass per speaker
The urgent reason bypass SHALL apply only to speakers whose `urgent` flag is on. Otherwise the call SHALL follow the normal approval path, not be refused.

#### Scenario: Urgent flag off
- **WHEN** an urgent reason is used on a speaker with `urgent` off
- **THEN** approval is requested as for a normal message

### Requirement: Volume permission
Volume changes SHALL be allowed only on speakers with `volume` on and SHALL be clamped to that speaker's ceiling.

#### Scenario: Ceiling
- **WHEN** a volume above the ceiling is requested
- **THEN** it is clamped to the ceiling

### Requirement: Owner-only edits
Changes to speaker flags SHALL be made only by the authenticated owner on the admin page, which backs up the catalog first. They SHALL NOT be possible through agent-facing tools.

#### Scenario: Flag edit
- **WHEN** the owner enables `announce` for a speaker
- **THEN** the catalog is backed up and saved, and the change applies to the next call
