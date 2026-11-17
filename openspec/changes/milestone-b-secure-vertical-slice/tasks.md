# Tasks

## 1. Foundations and interfaces

- [x] 1.1 Define `AlexaAdapter`, `OperationStore` and `CredentialStore` interfaces over the Milestone A modules, with the existing probes unchanged; verify `npm test` still passes
- [x] 1.2 Add a fake Alexa adapter and a blocked-network guard for tests (the fake identity provider is built in 4.2 where it is first used); verify a test run cannot make a non-loopback connection
- [x] 1.3 Add dependencies (`oidc-provider`, MCP SDK, Azure identity and Key Vault SDKs; the SQLite choice is added in 3.1) and verify install, lint, build and `npm run scan:secrets`

## 2. Native HTTP MCP and read-only inventory

- [x] 2.1 Implement the Streamable HTTP endpoint with origin validation, size limits and schema validation; verify tests for invalid origin, oversized and malformed input
- [x] 2.2 Implement read-only inventory tools with per-device errors, stale and missing markers and the `reauthentication_required` result; verify partial-failure and stale-value tests
- [x] 2.3 Write the example client and its README, using a static test client; verify it runs against a local instance with the fake adapter

## 3. Operation journal

- [x] 3.1 Spike: SQLite option (`node:sqlite` versus a binding) and durability on a network-backed share across restart and swap; record the result in the design and verify with a repeatable script
- [x] 3.2 Implement the journal behind `OperationStore`: write before dispatch, update after, and `not_dispatched` when the write fails; verify unit tests
- [x] 3.3 Implement per-target ordering and `superseded`, covering retry and verification steps; verify deterministic overlap tests in both command orders and at timing boundaries
- [x] 3.4 Implement restart recovery (`unknown`, no replay) and operation-key idempotency; verify crash-window and repeated-key tests
- [x] 3.5 Implement principal-scoped journal access; verify a cross-principal lookup returns not found

## 4. Authorization

- [x] 4.1 Implement the issuer with metadata, PKCE `S256` required, approved-redirect registration and hashed token storage; verify negative tests (no PKCE, unknown redirect, wrong audience, token store disclosure)
- [x] 4.2 Implement the owner sign-in against the identity provider keyed on the object ID, refusing other accounts; verify tests with the fake identity provider
- [x] 4.3 Implement refresh rotation with replay detection; verify a replayed old token is rejected
- [x] 4.4 Implement scopes and the no-model-granted-privilege rule; verify a read-only token and a "confirmed" argument both fail on the mutation tool

## 5. Mutation and policy

- [x] 5.1 Owner decision gate: choose the one low-risk mutation and the allow-listed target, and record only a sanitized description in the repository
- [x] 5.2 Implement the allow-list policy, refused safety classes, unknown-class refusal and inventory validation; verify tests that nothing is dispatched on rejection
- [x] 5.3 Wire the mutation through the journal and policy and return structured outcomes; verify with the fake adapter for accepted, verified, failed, unknown and superseded

## 6. Cloud deployment

- [x] 6.1 Implement the Key Vault `CredentialStore` with an optimistic version check on writes; verify tests with a fake vault, including a stale-write rejection
- [x] 6.2 Write Bicep for App Service, Key Vault, managed identity and settings, with no secrets; verify `az bicep build`, a what-if run and the secret scan
- [x] 6.3 Add public liveness and coarse readiness endpoints; verify an anonymous response holds no account, device or session detail
- [x] 6.5 Add the server entrypoint `src/server.ts` that wires configuration, Key Vault session store, issuer, owner sign-in, mutation service and HTTP server; verify with a boot test using fakes and a failure when required settings are missing
- [x] 6.4 Document deploy, restart, rollback and reauthentication in `docs/`; verify by following the steps in a throwaway resource group

## 7. Integration and owner-approved live evidence

- [x] 7.1 End-to-end test: example client to issuer to MCP to policy to journal to fake adapter, covering success, failure, uncertainty and authorization cases; verify the full suite passes in CI
- [ ] 7.2 Owner-approved window: seed the session to Key Vault and read inventory from the cloud instance; record sanitized evidence of session survival and refresh from the cloud address; also run `scripts/sqlite-spike.mjs` on the App Service `/home` share
- [x] 7.3 Owner-approved window: run the single mutation on the allow-listed target; record the sanitized outcome and journal record
- [ ] 7.4 Connect ChatGPT and Claude through the authorization flow; record sanitized compatibility notes, including DCR versus CIMD
- [x] 7.5 Security pass against the criteria in `REQUIREMENTS.md` section 13 (invalid audience, cross-principal, origin, size, log leakage); verify with a documented checklist and test references

## Workflow follow-up

- Archive the change after the owner's review and after the live evidence is recorded.
