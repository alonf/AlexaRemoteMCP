## Context

Alexa gives only generic classes for KNX-backed devices (heaters and outlets are `SWITCH`; the KNX gateway's `DeviceClass` has 1 light, 2 heater, 3 outlet, 4 AC, 5 shutter, 7 boiler). The catalog adds that knowledge without putting household data in git.

## Decisions

- **Storage:** a JSON file under `/home/data` (persistent, outside git), cached in memory. A Key Vault secret is rejected as the primary store because its 25 KB limit is too small for about 270 devices with descriptions.
- **Precedence:** hard-blocked class, then allow-list, then the device's group, then `ACTION_POLICY` category mode. The catalog can only widen within non-blocked classes, so a bad entry cannot unlock a camera or alarm.
- **Categories:** `climate` splits into `heater` and `ac` (AC heats too, but is considered safe); `outlet` is new.
- **Edits:** a single `update_device_catalog` tool reusing the `ApprovalSigner` with a digest of the normalized change set. A catalog edit is the highest-risk action, since it could unlock devices, so it is never allow-mode, even if `ACTION_POLICY` allows everything.
- **Persistence:** write to a temp file and rename; keep the previous version for one rollback.
- **Draft script:** name matching on English names (`EName`) normalized; aggregates ("All heaters") become groups when the KNX gateway names them.
- **UI:** deferred; it will use the same schema and the same approval-gated write path.

## Risks

- Name matching can mis-tag devices; the draft is reviewed by the owner before use.
- A stale catalog may name devices Alexa no longer reports; unknown IDs are ignored with a warning, not fatal.
- Clients without MRTR cannot edit; the owner edits the file directly.
