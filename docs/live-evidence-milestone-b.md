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

## Not shown

- Session refresh from the cloud address. The 6-hour refresh timer restarts on every deploy and has not yet run
  in a deployment that stayed up long enough. Task 7.2 stays open for this.
- A live 429 retry. The retry path is covered by a unit test only.
- Whether `unknown` outcomes from slow state reads occur in normal use; one local state read stalled for more than six
  minutes.
