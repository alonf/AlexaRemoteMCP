# Milestone B security pass

Checked against `REQUIREMENTS.md` section 13, criterion 10 (and related criteria). Each row names
the test that fails if the behavior regresses. All tests run offline with fakes.

| Concern | Result | Evidence |
| --- | --- | --- |
| Unauthenticated access | Challenged with 401 and `WWW-Authenticate`; nothing dispatched | `http-server.test.ts` "unauthenticated request gets a challenge"; `e2e.test.ts` "requests without a valid token are challenged" |
| Incorrect audience | Token for another audience refused; resource other than the MCP resource refused; refresh cannot change resource | `issuer.test.ts` "a token minted for another audience", "a resource other than the MCP resource"; `refresh.test.ts` "a refresh cannot ask for a different resource" |
| Upstream ID token | Wrong audience, nonce or missing account claim refused; other accounts get no code | `signin.test.ts` |
| Cross-principal | Journal records and operation keys are per principal | `sqlite-recovery.test.ts` "another principal cannot see the operation", "keys are per principal" |
| Privilege from model input | A `confirmed` argument grants nothing; read-only token cannot mutate | `mutation-tools.test.ts`; `e2e.test.ts` "a read-only grant reads but cannot mutate" |
| Authorization before dispatch | Allow-list, safety class and capability checks run first; refusals write nothing and leave no journal record | `mutation-policy.test.ts`; `mutation-tools.test.ts` "targets outside the allow-list" |
| Injection | Tool arguments are schema-validated (id length, integer brightness 0-100, key length); no shell, SQL string building or dynamic code from input (journal uses bound parameters) | `mutation-tools.test.ts` "brightness is range-checked" |
| SSRF | The only outbound HTTP from request handling is to the configured identity provider's discovery and token endpoints. No request-supplied URL is fetched. Redirect URIs are an owner-approved allow-list checked at registration | `issuer.test.ts` "an unapproved redirect URI is rejected" |
| Invalid origin, oversized, malformed | 403, 413, 400 before dispatch | `http-server.test.ts` "invalid origin, oversized and malformed requests" |
| Token and code storage | Only digests are stored; codes cannot be reused or redeemed with a wrong verifier; refresh reuse revokes the grant | `issuer.test.ts` "the token store holds no usable token", "an authorization code cannot be reused"; `refresh.test.ts` |
| Log and error leakage | Vault, session and upstream errors carry generic messages; the service logs no request content; the logger redacts untrusted detail; a start failure names only missing setting names | `keyvault-session-store.test.ts` "vault failures do not expose upstream messages"; `logger.test.ts`; `service.test.ts` "missing required settings" |
| Anonymous health | `/healthz` and `/readyz` return only a coarse status | `http-server.test.ts` "anonymous health endpoints are coarse" |
| Duplicate or uncertain effects | Keyed replay returns the original result; a crash window records `unknown` and never replays; newest command wins per target | `sqlite-recovery.test.ts`; `mutation-tools.test.ts`; `target-ordering.test.ts` |

## Known gaps (not silently passed)

- No rate limiting on `/reg`, `/token` or `/mcp`. Registration is limited by the redirect-URI
  allow-list and sign-in is limited to the owner account, but request volume is unbounded. Needs
  an owner decision before public exposure (App Service access restrictions or an in-process limiter).
- The upstream sign-in pending state is in memory, so a restart during sign-in forces a retry.
- Node's `node:sqlite` is experimental; durability on the App Service `/home` share is unverified until task 7.2.
- `npm audit --omit=dev` reports three low findings from `alexa-cookie2`, which predate this work.
- Live behavior (Amazon session from an Azure address, ChatGPT and Claude compatibility) is not covered here; tasks 7.2 to 7.4 record that evidence.
