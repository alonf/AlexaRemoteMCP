# Design

## Context

Milestone A left a local proof harness in `src/`: a session manager (single refresh owner), a credential store, an action-outcome vocabulary, a local journal, an approvals module and probes. Milestone B reuses these through interfaces (`AlexaAdapter`, `OperationStore`, `CredentialStore`, per `REQUIREMENTS.md` section 14) rather than rewriting them. See proposal.md for scope and motivation.

Two sibling projects by the same owner already run OAuth for ChatGPT and Claude: one with its own issuer on `oidc-provider` plus Entra sign-in, another with a thin authorization layer that delegates sign-in to Entra External ID. Both found the same constraint: Entra alone cannot be the authorization server for ChatGPT (no `S256` advertisement, no registration endpoint). This design follows that proven pattern and does not copy their code or any household detail.

## Goals / Non-Goals

**Goals:**
- A small, testable path from a remote client to one journaled mutation, with every security boundary exercised.
- Interfaces that keep Milestone C and the optional HA edition possible without building them now.

**Non-Goals:**
- A shared issuer package across projects (copy the pattern, cite it).
- HA, queues, multi-tenant use, or any link to the owner's home automation gateway.

## Decisions

### D1. Own issuer on `oidc-provider`, Entra only for the owner sign-in
The service embeds an issuer (`oidc-provider`, MIT) that serves discovery metadata, DCR or CIMD for approved redirect URIs, PKCE `S256` and `resource`-bound tokens. Interactive login redirects to Entra and continues only if the Entra object ID equals the configured owner. The principal is keyed on the object ID, not `sub`, because Entra issues a different `sub` per app registration.
- Alternatives: Entra directly (cannot serve ChatGPT, as both sibling projects found); a hosted provider such as Auth0 (new vendor, bill and account); a static bearer token (not accepted by ChatGPT, and no revocation).
- Tokens and refresh tokens are stored as hashes; refresh rotates and detects replay.

### D2. Hosting: one Azure App Service B1 Linux instance
Always On, one instance, HTTPS and certificates managed. No tunnel and no router rules. Key Vault (Standard, no monthly fee, cents per month at this volume) holds the issuer signing key, client secrets and the Amazon session, read through a managed identity.
- Alternatives: home host behind an outbound tunnel (cheaper, but adds a tunnel dependency and a home availability dependency); container apps (more moving parts for one instance).
- Cost figures are list-price estimates and must be checked against the first bill.

### D3. Session store interface with file and Key Vault implementations
`CredentialStore` gets a second implementation backed by Key Vault. The session manager remains the single refresh owner and the upstream auto-refresh and implicit login stay disabled. Cloud refresh writes the new session back to Key Vault with an optimistic version check so a stale write cannot overwrite a newer one.
- Seeding: the owner signs in locally through the existing loopback flow and approves an explicit one-time transfer to Key Vault. Passwords, MFA codes and CAPTCHA never pass through the service or any tool.
- Alternative: sign in from the cloud host. Rejected, because it needs the login proxy to be public.

### D4. Journal in SQLite with an ordering key per target
The journal uses SQLite (built-in `node:sqlite` if stable enough on the pinned Node, else a native binding, decided in a spike). Rows are written before dispatch and completed after. A per-target intent counter supports newest-wins: before each dispatch and each retry or verification step, the operation checks that its intent is still current, and otherwise ends as `superseded`. This is the same ordering rule proven in the KNX gateway work.
- Spike result (3.1): built-in `node:sqlite` (Node 24, SQLite 3.50.4, experimental warning suppressed) in `journal_mode=DELETE` with `synchronous=FULL` kept every acknowledged row and passed `integrity_check` after three forced kills, both on a local disk and on an SMB share (`scripts/sqlite-spike.mjs <dir>`). This does not prove App Service `/home` behaviour or deploy swaps; task 7.2 repeats the script there, and the fallback below still applies. The built-in module is used with a pinned Node version.
- Persistence on App Service uses the network-backed `/home` share. SQLite locking on that share is a known risk, so the journal runs in rollback-journal mode with one writer in one process, and a spike verifies durability across restarts and deploy swaps before any live use. Fallback if the spike fails: Azure Table Storage or Azure SQL behind `OperationStore`.
- Restart: incomplete records become `unknown`; non-idempotent actions are never replayed. A client operation key makes retries return the original record.

### D5. Policy by allow-list, not deny-list
The mutation tool accepts only targets on an explicit allow-list and only a low-risk action. Safety classes (shutters, heaters, air conditioning, locks, gates) are refused, and an unknown class is refused. Scopes (`read`, `mutate`) come from the owner's grant, and arguments such as a model-supplied "confirmed" flag never grant privilege.

### D6. Privacy and logging
Logs use fixed event names only, as in Milestone A. Journal rows hold hashes and IDs, not payloads. No account identifier, device name or address is logged. Public health shows liveness only. Evidence from live tests is sanitized before it enters the repository.

### D7. Testing
Automated tests use a fake Alexa adapter and a fake identity provider (a second `oidc-provider` instance standing in for Entra), and need no account or network. Live tests, including the cloud session survival check, run only in owner-approved windows and are recorded as sanitized evidence.

## Risks / Trade-offs

- [Amazon challenges or rejects a refresh from an Azure address] → The slice treats this as a finding. State goes to `reauthentication_required`, with no sign-in loop. If it fails, the fallback is a home host behind a tunnel using the same interfaces.
- [Owning OAuth code adds security-critical surface] → Keep it thin on `oidc-provider`, add negative tests (wrong audience, replay, unknown redirect, PKCE missing), and run a security review before any public claim.
- [SQLite on a network share] → See D4: spike first, with a store fallback behind the interface.
- [Session in Key Vault widens the credential blast radius] → Managed identity with least privilege, soft delete and purge protection, no secret in settings, and secret scanning in CI.
- [Cost drift] → Re-check the bill in the first month; the budget is about $13 a month plus cents.
- [Single instance is a single point of failure] → Accepted by `REQUIREMENTS.md`; HA is a later, separate edition.

## Migration Plan

1. Build and test locally with the file store and fake adapters.
2. Deploy the infrastructure code to a new resource group, with no live account access.
3. Seed the session only in an owner-approved window, then run the read-only inventory.
4. Run the single mutation in a second approved window on the allow-listed target.
5. Rollback: redeploy the previous package, and delete the Key Vault session secret to revoke local access. Amazon-side session revocation is not claimed unless verified.

## Open Questions

- Decided (5.1): the mutations are the low-risk light actions, power on/off and brightness, exposed as separate MCP tools so the client app's own per-tool enable/disable lets the owner choose which are allowed. The target allow-list is configuration held outside the repository; the first live window uses one indoor light that is acceptable to toggle. Safety classes stay refused whatever the tools are. DCR is implemented now (CIMD is not).
- DCR versus CIMD per client: implement what each client's current documentation requires, and record it in the compatibility notes.
- Whether the owner's Entra tenant is workforce or External ID. The login redirect works with either and only the configuration differs.
