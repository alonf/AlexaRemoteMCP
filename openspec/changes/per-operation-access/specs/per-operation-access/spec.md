# Spec Delta

## Purpose

Lets the owner set a different permission mode per operation on a device.

## ADDED Requirements

### Requirement: Per-operation override
A catalog entry MAY carry `operations`, mapping any of `power_on`, `power_off`, `brightness`, `open`, `close`, `stop`, `step` to `allow`, `approve` or `deny`. A mutation SHALL use the override for its operation when present, otherwise the entry's group mode, otherwise the category mode. Unknown operation names or modes MUST be rejected at load and on edit.

#### Scenario: On needs approval, off does not
- **WHEN** a light's `power_on` is `approve` and `power_off` is unset under a `low-risk` group
- **THEN** turning it on requires approval and turning it off is allowed

#### Scenario: Off needs approval
- **WHEN** a device's `power_off` is `approve`
- **THEN** turning it off requires approval

#### Scenario: Denied operation
- **WHEN** an operation is `deny`
- **THEN** the call is refused with `category_denied`

### Requirement: Overrides never loosen hard limits
An override MUST NOT affect hard-blocked classes, disabled devices, unsupported devices or read-only devices; those checks run regardless of the override.

#### Scenario: Blocked class
- **WHEN** a camera entry sets `power_off` to `allow`
- **THEN** the call is still refused with `safety_class`

### Requirement: Admin page control
The admin page SHALL show an override select for each operation the device supports and none for locked or disabled devices.

#### Scenario: Locked device
- **WHEN** a device is unsupported or read-only
- **THEN** no operation selects are shown
