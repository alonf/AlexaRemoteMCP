# Cloud deployment (Milestone B)

The service runs as a single Azure App Service (Linux, B1, one instance) with a Key Vault. The
web app uses a system-assigned managed identity; no secret appears in the repository, the Bicep
file or the deployment parameters.

## What is deployed

| Resource | Purpose |
| --- | --- |
| App Service plan (B1, 1 instance) | Hosts the service. One instance only: the journal and the session writer are single-process by design. |
| Web app | Runs `node dist/src/server.js`; HTTPS only, TLS 1.2+, FTP disabled, health check `/healthz`. |
| Key Vault (RBAC, soft delete, purge protection) | Holds the Alexa session (`alexa-session`), the issuer signing and cookie keys (`issuer-keys`) and the Entra client secret (`entra-client-secret`). |
| Role assignment | Web app identity gets *Key Vault Secrets Officer* on the vault only. |

## Settings

Set by `infra/main.bicep`: `KEY_VAULT_URI`, `PUBLIC_BASE_URL`, `JOURNAL_PATH`, `ENTRA_TENANT_ID`,
`ENTRA_CLIENT_ID`, `APPROVED_REDIRECT_URIS`, and `ENTRA_CLIENT_SECRET` as a Key Vault reference.

Set after deployment and never committed (they are household-specific):

- `OWNER_ACCOUNT_ID`: the owner's Entra object ID. Only this account can authorize a client.
- `MUTATION_ALLOWED_TARGETS`: comma-separated device IDs the mutation tools may touch. Empty
  means the mutation tools are not registered at all (unless `ACTION_POLICY` enables them, in
  which case `*` or an empty list means every device the policy permits). The list only narrows
  what `ACTION_POLICY` allows.
- `ACTION_POLICY`: one setting that picks `allow`, `approve` or `deny` per category. Either a
  preset or `category=mode` pairs, for example `light=allow,cover=approve,heater=approve`.
  - Categories: `query`, `light`, `cover` (shutters, blinds), `heater` (heaters, fans), `ac`
    (air conditioners and thermostats; they heat and cool), `outlet` (plugs), `access` (locks,
    doors, garage), `other`. Unlisted categories are `deny`.
  - Presets: `read-only`, `lights-only` (the default when unset), `lights-allow-rest-approve`.
  - `approve` asks the owner through an MCP Multi Round-Trip Request (protocol 2026-07-28) on
    every call. Clients that do not support it are refused (`approval_unsupported`), never
    allowed. The signing key is the Key Vault secret `approval-key`, created by the app.
  - Chat confirmation: a client that cannot elicit (ChatGPT today) does not get refused. The
    server replies `confirmation_required` with a question and an `approvalId`, and sends
    nothing. The assistant asks the user and, only on a yes (typed or spoken), repeats the call
    with `approvalId` and `confirmed=true`. The id is signed, single-use, bound to the device
    and action, and expires in 2 minutes; a confirmation under 3 seconds after the ask is
    refused. The server cannot verify that a human answered, so set `CHAT_CONFIRMATION=off` to
    restore the refusal. Catalog edits never use it.
  - `query=approve` is invalid. Security panels, alarms, smoke/CO detectors, cameras and valves
    are never actionable. An invalid value stops startup.
  - Warning: setting `access` to `allow` lets an agent unlock doors without asking; prefer
    `approve`.

The service refuses to start if a required setting is missing and names only the setting.

- `EVENT_CALLBACK_HOSTS` (default `connectors.api.openai.com`; empty disables events): hosts the
  server will send MCP Events webhooks to. A client with the read scope can `events/subscribe`
  to `approval.requested` and `session.attention`. Each subscription is verified with a signed
  challenge, lasts at most 24 hours, and is stored in `EVENTS_STORE_PATH` (default
  `/home/data/events.sqlite`) with its signing key sealed under a key derived from the Key Vault
  approval secret. Deliveries are signed (Standard Webhooks) and content-free doorbells: only a
  short summary such as `turn on "Boiler"`, never approval ids, tokens or Alexa text. Callbacks
  go only to allowed HTTPS hosts resolving to public addresses, with no redirects. Logs hold the
  event, a hash of the client, the host and the status.
- `SPEAK_POLICY` (`off` default, `approve` or `allow`) and `SPEAK_TARGETS` (comma-separated Echo
  names or serials, `*` for all): enable `list_speakers` and `speak`, which say a plain text of
  at most 250 characters on allowed Echo devices (`speak` on one, `announce` on several). With
  `approve` the owner approves the exact text and device first. At most 5 texts per 10 minutes.
  Unknown and disallowed devices get the same refusal. The journal and logs hold only a digest,
  the target count and the outcome, never the text or device names. `accepted` means Alexa took
  the request, not that it was heard.
- `SPEAK_URGENT_REASONS` (comma-separated tokens, empty default, for example
  `emergency,security,safety,health,family,time_critical`) and `SPEAK_URGENT_LIMIT` (default 2 per
  10 minutes): a `speak` call with one of these `reason` values skips approval. The reason is
  claimed by the agent and cannot be verified, so everything else still applies (allowed devices,
  plain text, offline refusal) and a call over the urgent limit is refused, not downgraded. Each
  one publishes a `speech.urgent` event (reason only) and is journaled as `speech-urgent:<reason>`.
  - `LISTS_REMINDERS_READ=on` (default off): enables read-only `list_lists`, `get_list_items` and
    `list_reminders` (read scope). Only ids, names, text, status and times are returned.
  - `get_status` (read scope) returns session health and your pending approvals. The doorbell also
    publishes `action.completed` (summary and status only) when a mutation finishes.
## Deploy

1. Register an Entra app (web platform, redirect URI `<base URL>/signin/callback`) and note the
   tenant ID, client ID and a client secret.
2. Create the resource group and deploy:

   ```powershell
   az group create -n rg-alexa-mcp -l westeurope
   az deployment group create -g rg-alexa-mcp -f infra/main.bicep -p namePrefix=alexamcp `
     entraTenantId=<tenant> entraClientId=<client> approvedRedirectUris=<comma-separated URIs>
   ```

3. Store the Entra client secret in the vault as `entra-client-secret`. Your account needs
   *Key Vault Secrets Officer* on the vault, which the deployment does not grant to you:

   ```powershell
   az role assignment create --assignee-object-id (az ad signed-in-user show --query id -o tsv) `
     --assignee-principal-type User --role "Key Vault Secrets Officer" `
     --scope (az keyvault show -n <vault> --query id -o tsv)
   ```

   Role assignments take about a minute to propagate; a `Forbidden` error right after the grant is normal.
4. Set `OWNER_ACCOUNT_ID` and, when ready for the mutation window, `MUTATION_ALLOWED_TARGETS`:

   ```powershell
   az webapp config appsettings set -g rg-alexa-mcp -n <site> --settings OWNER_ACCOUNT_ID=<oid>
   ```

5. Publish the build. Stage `dist`, `package.json`, `package-lock.json` and `patches`, run
   `npm ci --omit=dev` in the staging folder (this applies the required upstream auth-guard patch;
   without `patches` the service fails closed and `/readyz` stays 503), zip it and deploy with
   `az webapp deploy --type zip --async true`. The first start takes several minutes, and the CLI may
   still print a startup warning or exit non-zero; judge the result by the endpoints, not the CLI.
   Check `GET /healthz` returns 200 and `GET /readyz` returns 200 once the session is seeded (503
   before that is expected).
   Set `ALEXA_DIAG=1` temporarily to log a redacted backend failure message.

## Device catalog page and backups

`https://<site>/admin/catalog` is the owner's catalog page. The page itself is a static shell; its
API (`/admin/api/*`) accepts only a token with the `admin` scope, which is granted only to the
page's own OAuth client (redirect URI `<PUBLIC_BASE_URL>/admin/catalog`) after owner sign-in, and is
never advertised to MCP clients. Changes save immediately to `CATALOG_PATH`
(default `/home/data/device-catalog.json`). The page can also import a whole catalog file.

Each entry has a category, an optional group, and an optional `operations` map that overrides
the mode per operation (`power_on`, `power_off`, `brightness`, `open`, `close`, `stop`, `step`, each `allow`,
`approve` or `deny`), so turning a light off can be allowed while turning it on needs approval.
For shutters, `stop` sends a step in the direction of travel (the caller states it) rather than
the skill's `Position.Stop`, which steps down and would reverse a rising shutter; `step` is a
short step up or down.
Overrides never loosen blocked, disabled, unsupported or read-only devices.

Before an edit changes the file, the previous state is uploaded to the private blob container
`CATALOG_BACKUP_CONTAINER` (default `catalog-backups`) in the account at `CATALOG_BACKUP_URL`,
using the app's managed identity (role "Storage Blob Data Contributor"; shared keys are disabled).
A burst of edits shares one snapshot taken within the previous 5 minutes. If the upload fails the
edit is refused. Without `CATALOG_BACKUP_URL` only the local `.bak` copy exists. The catalog and the
category policy are read at startup, so restart after the first import to enable catalog-based
policy and the MCP catalog tools.

## Seed or re-seed the Alexa session (reauthentication)

`/readyz` returns 503 until the session is usable. When it reports not ready, or after Amazon
requires a new login, run the login helper locally (it signs in interactively and saves to the
protected local store), then write the resulting session JSON to the vault secret `alexa-session`
and restart the web app. Never paste the session into chat, logs or the repository.

## Restart

```powershell
az webapp restart -g rg-alexa-mcp -n <site>
```

On start, any journal record with no outcome is marked `unknown`; nothing is replayed to Amazon.

## Rollback

Redeploy the previous build zip. The journal (`/home/data/journal.sqlite`) and token store are
on the persistent `/home` share and survive redeploys. Rotating `issuer-keys` (delete the secret
and restart) invalidates every issued token and forces clients to reauthorize.

## Known limits

- Key Vault has no conditional write. The session store re-reads the latest version before
  saving and rejects a stale writer, which narrows but cannot fully close a race; hence one
  instance.
- Whether SQLite is durable on the App Service `/home` share is verified by task 7.2
  (`scripts/sqlite-spike.mjs`), and whether Amazon accepts the session from an Azure address is
  also verified there.
