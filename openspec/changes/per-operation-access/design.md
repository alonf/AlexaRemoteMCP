## Context

`judgeDevice` picks a mode from the catalog group or the category mode. The mutation service already distinguishes on, off, brightness and open/close.

## Decisions

- **Per device only.** Overrides live on the device entry. Inheriting from group entries is deferred because group members are descriptive today and inheritance would add precedence rules.
- **Precedence:** hard block, disabled, operation override, group, category; then supported and writable checks.
- **Off is not special.** An AC main breaker or heater may need approval to switch off.
- **A `deny` override** reuses `category_denied`.
- **Agent edits** go through the existing approval-gated `update_device_catalog`; no new loosening path beyond what group edits already allow.

## Risks

- An approved agent edit could set an override to `allow`. This matches the existing power of editing a group, and the hard limits still apply.
