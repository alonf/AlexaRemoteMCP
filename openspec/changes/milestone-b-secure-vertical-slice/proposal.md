# Proposal

## Why

Milestone A reduced Alexa connectivity risk with a local probe. The MCP is not yet reachable by real clients, and it has no authorization, no remote hosting, no operation journal and no restart handling. Milestone B is a thin end-to-end slice that tests the architecture before the full MVP is built. A remote client must sign in, read inventory, run one controlled mutation and see an honest, durable outcome.

## What Changes

- Add a native Node.js/TypeScript Streamable HTTP MCP endpoint, independent of the old stdio project.
- Add an OAuth 2.1 authorization layer, using the pattern proven in two sibling projects: an own issuer on `oidc-provider`, PKCE `S256`, dynamic client registration or Client ID Metadata Documents limited to ChatGPT and Claude redirect URIs, and `resource`-bound tokens stored as hashes. A single owner principal signs in through Microsoft Entra. A static-entry client supports local tests and the example client.
- Host the slice as a single cloud instance (Azure App Service B1 Linux, with a Key Vault for secrets and managed identity). No router rules, no tunnel.
- Add a session-store interface. Milestone A's owner-restricted file store stays for local use. Key Vault becomes the cloud store, seeded from a sign-in done at the owner's machine.
- Add read-only inventory tools.
- Add one low-risk controlled mutation, behind an action policy that refuses safety-relevant device classes by default.
- Add a SQLite operation journal with honest outcomes (`accepted`, `verified`, `unknown`, `superseded`), with the newest command winning for the same target, and restart recovery that never blindly retries a non-idempotent action.
- Add an example client and infrastructure-as-code (Bicep) for the slice.
- Record, as evidence rather than an assumption, how long the Alexa session survives when refreshed from a cloud IP.

## Scope

This milestone is an architecture test, not the full MVP in `REQUIREMENTS.md`. Requirement references: ARCH-01..06, MCP-01..06, SEC-01..09, AUTH-01..05, REL-01..08, CAP-01..04, DEP-01..07, OSS-01..07 (partial, as the slice allows), and the Milestone B acceptance criteria in section 13.

## Non-Goals

- The full tool catalogue, scenes, routines and broad device control.
- Alexa+ compatibility certification (PLUS-*), proactive state reporting and high availability.
- Any link to the owner's home automation gateway.
- Household-specific details in this public repository, and live Alexa actions without owner approval.

## Capabilities

### New Capabilities
- `mcp-http-service`: the Streamable HTTP MCP endpoint, tool surface, inventory reads and the example client contract.
- `mcp-authorization`: OAuth issuer, client registration, token binding, owner sign-in and scope enforcement.
- `operation-journal`: durable operation records, outcome vocabulary, ordering and restart recovery.
- `controlled-mutation-policy`: the single permitted mutation and the policy that blocks other device classes.
- `cloud-deployment`: the single-instance cloud hosting, secret store and session-store contract.

### Modified Capabilities
- `amazon-session-persistence`: adds a pluggable store (file for local, Key Vault for cloud) without weakening the local owner-restriction guarantees.

## Impact

- New code: HTTP server, issuer, policy, journal, session-store adapters, example client.
- New dependencies: `oidc-provider` (MIT), a SQLite binding, the MCP SDK, and Azure SDK packages.
- Infrastructure: App Service, Key Vault and an Entra app registration, at an expected cost of about $13 a month plus cents for Key Vault (list-price estimate, to be checked against the first bill).
- Unresolved decisions for `design.md`: whether the Alexa session survives from a cloud IP, the choice of the one mutation, DCR versus CIMD per client, and how sessions are seeded into Key Vault.
