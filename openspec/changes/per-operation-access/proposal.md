## Why

Risk depends on the operation, not only the device. Turning all lights off is low risk while turning them on may need approval, and turning off an AC main breaker may need approval too. A single mode per device cannot express that.

## What Changes

- A catalog entry gains optional `operations`, a per-operation mode (`allow`, `approve`, `deny`) for `power_on`, `power_off`, `brightness`, `open` and `close`.
- An operation without an override follows the device's group, then its category (unchanged behaviour).
- "Off" has no built-in exemption; it is an operation like any other.
- The admin page shows per-operation selects for the operations a device supports.
- Overrides never loosen hard-blocked classes, disabled devices, unsupported or read-only devices.

Out of scope: group-level overrides inherited by members, and per-capability controls for tools that do not exist yet (volume, channel).

## Capabilities

### New Capabilities
- `per-operation-access`: per-device, per-operation permission modes.

### Modified Capabilities
None.

## Impact

`src/catalog.ts`, `src/mutation-policy.ts`, `src/mutation-service.ts`, `src/admin-page.ts`, the `update_device_catalog` tool description, and tests. No stored-format break: existing catalogs stay valid.
