# Proposal

## Why

Alexa reports most household devices as generic switches, so device classes cannot tell a heater from an outlet, nor say which devices are groups or dimmable. Per-category modes are also too coarse: the owner wants to tag individual devices. The knowledge is household data and cannot live in the public repo.

## What Changes

- Add a private **device catalog** (JSON, outside git) keyed by Alexa device ID, whatever bus the device comes from. Each entry holds a category, a permission group, a disabled flag that hides the device from agents, and a free-text description for the agent. Dimming is known from the Alexa capabilities, so it is not stored.
- Add **permission groups** defined in the catalog: `low-risk` (allow), `requires-approval` (approve) and `read-only` (deny writes). A device's group is assigned per device and decides its mode; devices without a group fall back to the `ACTION_POLICY` category mode.
- Rename policy categories to `heater` (heating only) and `ac` (air conditioners, which heat and cool). **BREAKING** for any `climate` token in `ACTION_POLICY` (not yet deployed).
- `list_devices` includes the catalog's category, traits and description so the agent knows how to use each device.
- Add an MCP tool to read and edit the catalog. Every edit requires owner approval through MRTR, and an edit can never raise a device's permissions without it.
- Add a local script that drafts a catalog by matching the Alexa inventory to the KNX gateway device list.
- A setup UI is out of scope here and follows as a later change on the same schema.

## Capabilities

### New Capabilities
- `device-catalog`: private catalog format, permission groups, category override and agent-visible metadata.
- `catalog-editing`: reading and approval-gated editing of the catalog through MCP, and the draft-generation script.

### Modified Capabilities

## Impact

- `src/action-policy.ts`, `src/mutation-policy.ts`, `src/inventory.ts`, `src/http-server.ts`, `src/service.ts`, a new `src/catalog.ts` and a `scripts/` draft tool.
- New private setting/storage for the catalog (`/home/data` file); no household data in git.
- Builds on `mutation-approval-policy`, which must land first.
