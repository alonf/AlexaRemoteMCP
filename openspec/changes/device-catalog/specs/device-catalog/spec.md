# Spec Delta

## Purpose

Gives the owner a private, per-device description of the household that sets each device's category, permission group and agent-facing notes.

## ADDED Requirements

### Requirement: Private catalog
The service SHALL load a JSON catalog keyed by device ID from private storage (a file under `/home/data`). The catalog MUST NOT be part of the repository, and the repository MUST contain only the schema and fake-ID fixtures. A malformed catalog MUST stop startup naming the offending field, never fall back to a looser policy.

#### Scenario: Invalid entry
- **WHEN** an entry has an unknown category, an unknown group or a member that is not a catalog ID
- **THEN** startup fails naming the field and the device ID

#### Scenario: No catalog
- **WHEN** no catalog is configured
- **THEN** behavior equals `mutation-approval-policy` with class-based categories

### Requirement: Category and permission group
Each entry SHALL carry a `category` (`light`, `cover`, `heater`, `ac`, `access`, `outlet`, `other`) and an optional permission group `low-risk`, `requires-approval` or `read-only`, mapped to `allow`, `approve` and `deny`. A catalog category overrides the class guess. A device with no group uses the `ACTION_POLICY` mode for its category, and the allow-list MUST still only narrow.
#### Scenario: Heater switch tagged
- **WHEN** a generic Alexa switch is catalogued as `heater` with group `requires-approval`
- **THEN** a write needs owner approval

#### Scenario: Read-only
- **WHEN** a device's group is `read-only`
- **THEN** every write is refused and reads work

### Requirement: Blocked classes stay blocked
Classes hard-blocked by policy (security, alarm, smoke, CO, camera, valve) MUST stay blocked whatever the catalog says.

#### Scenario: Blocked class
- **WHEN** a camera is catalogued as `light` with group `low-risk`
- **THEN** a write is refused

### Requirement: Agent-visible metadata
`list_devices` SHALL return each device's category, group, group traits (`groupKind`, `members`) and description, and SHALL omit devices the owner disabled. A disabled device SHALL also be unreadable and uncontrollable through MCP, and agents SHALL NOT edit it or the flag. Descriptions MUST be sanitized and length-capped as untrusted text.

#### Scenario: Group device
- **WHEN** a device is catalogued as a group with members
- **THEN** the agent sees the group and member IDs
