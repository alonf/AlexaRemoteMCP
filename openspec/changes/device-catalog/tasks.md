# Tasks

## 1. Categories and catalog model

- [x] 1.1 Rename `climate` to `heater`, add `ac` and `outlet`, and update presets, parser, refusal map and tests
- [x] 1.2 Add `src/catalog.ts`: schema, strict validation, group-to-mode mapping, sanitizing and length caps
- [x] 1.3 Load the catalog at startup (file under `/home/data`), failing on invalid content

## 2. Policy integration

- [x] 2.1 Apply precedence: blocked class, allow-list, device group, category mode; catalog category overrides the class guess
- [x] 2.2 Include category, group, traits and description in `list_devices`
- [x] 2.3 Unit tests: override, blocked class stays blocked, read-only, no-catalog default, invalid entries, group members

## 3. MCP editing

- [x] 3.1 Add read tool and `update_device_catalog` with approval through MRTR bound to the normalized change set
- [x] 3.2 Atomic save with one rollback copy, journal the edit without signed state
- [x] 3.3 Before each edit changes the file, copy the previous catalog to a private Azure Storage blob (managed identity); an edit is refused if the copy fails
- [x] 3.4 Tests: accepted, declined, unsupported client, changed payload, replay, invalid edit
- [x] 3.5 Server-hosted catalog page: static shell, PKCE sign-in with an owner-only `admin` scope, `/admin/api` list, edit and import, and tests

## 4. Draft script and docs

- [x] 4.1 Add a script to draft the catalog from the Alexa inventory and the KNX device list into a git-ignored path
- [x] 4.2 Document the catalog schema, storage and `ACTION_POLICY` interaction, and update the security review
- [x] 4.3 Run lint, tests and the secret scan

## 5. Owner-approved live checks

- [ ] 5.1 Review the draft catalog with the owner and load it privately
- [ ] 5.2 With owner approval, verify a heater, AC and shutter call and a catalog edit from a client
