## ADDED Requirements

### Requirement: Opt-in personal reads
The server SHALL register `list_lists`, `get_list_items` and `list_reminders` only when `LISTS_REMINDERS_READ=on`, and each SHALL require the read scope.

#### Scenario: Disabled by default
- **WHEN** the setting is absent
- **THEN** the tools are not listed

#### Scenario: Scope required
- **WHEN** a caller without the read scope calls a tool
- **THEN** the call is refused

### Requirement: Minimal payloads
Responses SHALL contain only ids, names or text, completion status and reminder time. Malformed upstream entries SHALL be dropped and upstream failure SHALL be reported as unavailable.

#### Scenario: Identifiers removed
- **WHEN** upstream entries include customer or device identifiers
- **THEN** they do not appear in the response
