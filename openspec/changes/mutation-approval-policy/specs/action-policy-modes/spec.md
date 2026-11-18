# Spec Delta

## Purpose

Lets the owner decide, per category of action, whether an AI agent may act without asking, only after owner approval, or not at all, using one simple setting.

## ADDED Requirements

### Requirement: Three modes per category
The service SHALL classify each device into one category (`query`, `light`, `cover`, `climate`, `access`, `other`) and apply one mode to it: `allow`, `approve` or `deny`. A category with no configured mode MUST be `deny` (SEC-07).

#### Scenario: Allow mode
- **WHEN** a call targets a category in `allow` mode and passes validation
- **THEN** it is dispatched without any approval step

#### Scenario: Deny mode
- **WHEN** a call targets a category in `deny` mode
- **THEN** it is `rejected` with a reason and nothing is sent to Amazon

#### Scenario: Unconfigured category
- **WHEN** a category has no mode in the setting
- **THEN** it behaves as `deny`

### Requirement: Single setting with presets
The mode map SHALL be set through one app setting, `ACTION_POLICY`, as comma-separated `category=mode` pairs or a named preset. An invalid value MUST stop the service from starting rather than fall back to a permissive mode.

#### Scenario: Explicit pairs
- **WHEN** `ACTION_POLICY` is `query=allow,light=allow,cover=approve,climate=approve`
- **THEN** reads and lights are allowed, covers and climate need approval, and access and other are denied

#### Scenario: Preset
- **WHEN** `ACTION_POLICY` is a known preset name such as `lights-only`
- **THEN** the preset's category modes apply

#### Scenario: Invalid value
- **WHEN** `ACTION_POLICY` contains an unknown category, mode or preset
- **THEN** startup fails with a message naming the invalid token

### Requirement: Allow-list narrows, never widens
When `MUTATION_ALLOWED_TARGETS` is set to device IDs, only those devices SHALL be actionable even if their category is allowed. The value `*` MUST mean every device in an allowed or approvable category. The allow-list MUST NOT turn a `deny` category into an allowed one.

#### Scenario: Device not listed
- **WHEN** the list names other devices and the target is not among them
- **THEN** the call is `rejected` before any Amazon call

#### Scenario: Wildcard
- **WHEN** the list is `*` and the target's category is in `allow` mode
- **THEN** the call proceeds

### Requirement: Unknown class is never allowed
A device whose category cannot be determined SHALL be treated as `other`, and a capability the device does not declare MUST be rejected before dispatch (CAP-02).

#### Scenario: Undeterminable class
- **WHEN** the device class is missing from the inventory
- **THEN** the call is evaluated as `other`

### Requirement: Backward-compatible default
When `ACTION_POLICY` is unset, the behaviour SHALL equal Milestone B: lights on the allow-list are allowed and every other category is denied.

#### Scenario: Legacy configuration
- **WHEN** only `MUTATION_ALLOWED_TARGETS` is set
- **THEN** allow-listed lights work and a shutter call is `rejected`
