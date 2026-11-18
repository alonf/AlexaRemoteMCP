# Milestone B live evidence: cloud mutation (2026-11-17)

Sanitized record of the owner-approved window for task 7.3. No device names,
account identifiers or tokens appear here. The target is the single
allow-listed light, set only in private configuration.

## Setup

- Service: Azure App Service B1 (West Europe) with Key Vault, own OAuth issuer, Entra sign-in.
- Client: `scripts/cloud-client.mjs` over the real authorization flow, scope `read mutate offline_access`.
- Session: the Alexa session seeded from the owner's PC into Key Vault; `/readyz` reported usable.
- Inventory read from the cloud returned 271 smart-home devices and exactly one match for the target.

## Findings

1. **Identifier.** `list_devices` exposes the endpoint identifier, but the write and state APIs accept only the legacy
   appliance identifier. The policy resolves it from the inventory (`controlId`) and uses it for the write and the
   verification read.
2. **Parameter shape.** The write takes `parameters` as a single object (`{"action":"turnOn"}`). An array wrapping it
   makes Amazon return HTTP 400, from the cloud and from the home PC alike. This was the Iteration 1 shape.
3. **Result.** With both fixes, `light_turn_on` returned `verified` (write accepted, then a state read matched `ON`).
   The owner confirmed the light changed.
4. **Throttling.** Amazon sometimes answers HTTP 429 with
   `{"message":"Too many requests. Try again in some time."}` on `/api/phoenix/state` writes.
   - The skill's Lambda log shows no invocation for those calls, so the action never ran.
   - It was seen from the cloud and, once, from the home PC; both share one Amazon session.
   - A local replay of the cloud's call sequence (inventory read, write, state read, write 65 s later) did not
     reproduce it, and a later cloud pair of writes 6 s apart succeeded. The rule behind it is not known and no
     Amazon documentation for it was found.
   - Handling: a 429 is retried with backoff (2 s, 6 s, 15 s). If it persists the outcome is `not_dispatched`.
     Before this change it was reported as `unknown`.
5. **Outcome sequence observed from the cloud.**

   | Call | Outcome |
   |---|---|
   | `light_turn_on`, first working attempt | `verified` |
   | `light_turn_off` 60 s later | `unknown` (429, before retry handling existed) |
   | `light_turn_on` 30 min later | `unknown` (429) |
   | `light_turn_on` after an app restart | `verified` |
   | `light_turn_off` immediately after | `unknown` (429) |
   | `light_turn_on`, then `light_turn_off` 6 s later, with retry handling | both written with SUCCESS; the on call returned `verified` |

   Each call was recorded in the journal before dispatch and ended with its outcome. The journal file was not
   exported for this note.

## SQLite durability on App Service (task 7.2, part)

`scripts/sqlite-spike.mjs` ran on the App Service `/home` share (Linux, Node 24 LTS, via the Kudu command API): three
rounds of a writer killed mid-run, each reopened with `integrity=ok` and every acknowledged row present. Result: PASS.
The spike files were removed afterwards.

## Clean-room documentation check (task 6.4)

`docs/cloud-deployment.md` was followed literally in a throwaway resource group with placeholder Entra values and a
dummy session; the group was deleted afterwards.

- Bicep deployment succeeded and created the vault, plan and site.
- Doc gap found and fixed: storing the Entra secret failed with `Forbidden` until the deploying account was granted
  *Key Vault Secrets Officer*; the document now gives the command.
- Staging, `npm ci --omit=dev` and zip deploy worked. The CLI printed a startup warning although the site came up;
  the document now says to judge by `/healthz`. `/healthz` returned 200 and `/readyz` 503, as expected before a session.
- Reauthentication step: a (dummy) `alexa-session` secret plus restart left `/healthz` 200 and `/readyz` 503, so the
  service fails closed on an unusable session.
- Restart and redeploy (rollback) worked, and `journal.sqlite` and `oidc.sqlite` on `/home/data` kept their original
  timestamps across both.
- Not exercised in the clean room: Entra sign-in and a real Amazon session. Both were exercised on the real deployment.
- Key Vault purge protection means the deleted vault stays soft-deleted for the retention period; its name is unique
  to that resource group, so nothing collides.

## Client compatibility (task 7.4)

### ChatGPT (2026-11-17)

- Registered through dynamic client registration (`/reg`), as client name `ChatGPT`, redirect URI
  `https://chatgpt.com/connector_platform_oauth_redirect`, public client (`token_endpoint_auth_method: none`),
  grants `authorization_code` and `refresh_token`. No client-ID metadata document (CIMD) was used; the issuer does not
  offer one.
- Sign-in through Entra and the consent step completed. The access token was audience-bound to the `/mcp` resource,
  scope `read mutate`, lifetime 3600 s; the refresh token lasted 30 days.
- The tools were listed and device inventory was read.
- A light command for a device that is not on the allow-list was refused by the policy (`target_not_allowed`) and
  nothing was sent to Amazon. This confirms the allow-list protects against a client holding the `mutate` scope.
- No client-side error was reported. The service does not log individual requests, so these notes come from the
  client store and the owner's report.

### Claude

Not yet recorded.

## Not shown

- Session refresh from the cloud address. The 6-hour refresh timer restarts on every deploy and has not yet run
  in a deployment that stayed up long enough. Task 7.2 stays open for this.
- A live 429 retry. The retry path is covered by a unit test only.
- Whether `unknown` outcomes from slow state reads occur in normal use; one local state read stalled for more than six
  minutes.
