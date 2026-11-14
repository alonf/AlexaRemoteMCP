# Spec Delta

## Purpose

Defines how the proof establishes and records Alexa+ status and per-operation compatibility, keeping verified, experimental and unsupported results separate and never overstating certainty.

## ADDED Requirements

### Requirement: Alexa+ status determination
The proof SHALL record, for the owner's account, whether Alexa+ is enabled, available or unknown, with region, locale and device family, and MUST NOT infer status from announcements or upstream issues (PLUS-01, §9).

#### Scenario: Status determinable
- **WHEN** the owner confirms the account state
- **THEN** it is recorded as enabled, not enabled or unknown with the date

#### Scenario: Status undeterminable
- **WHEN** it cannot be established
- **THEN** it is recorded as unknown, and all results carry that caveat

### Requirement: Per-operation compatibility entries
The evidence SHALL list each probed operation (sign-in/refresh, Echo and smart-home inventory, state, routine, speech if probed, DND, events if probed) with a status of `verified`, `experimental`, `unsupported` or `temporarily_unavailable`, a date, library version and sanitized environment (PLUS-05, CAP-03).

#### Scenario: Operation fails
- **WHEN** a probe fails under Alexa+
- **THEN** it is marked unsupported or unavailable while unaffected operations keep their status

#### Scenario: Not probed
- **WHEN** an operation was not live-tested
- **THEN** it is listed as untested and not as verified

### Requirement: No public support claim
Milestone A results SHALL NOT be presented as certification or product support; documents must say a single account and device set were tested (§2, OSS-07).

#### Scenario: Evidence published
- **WHEN** the evidence is shared
- **THEN** it states its limited scope and that source inspection is not live validation

### Requirement: Event ingestion judged, not assumed
If event behavior is probed, framing, fragmentation and reconnect results SHALL be recorded, and an open connection MUST NOT be reported as reliable events (PLUS-04).

#### Scenario: Connection opens only
- **WHEN** a connection opens but no valid event is observed
- **THEN** events remain experimental or unverified

### Requirement: Blocker decision recorded
The change SHALL end with a written go/no-go decision listing unresolved blockers before Milestone B begins (§12).

#### Scenario: Blocker open
- **WHEN** an auth, retry or compatibility blocker is unresolved
- **THEN** the decision is not go and Milestone B is not started
