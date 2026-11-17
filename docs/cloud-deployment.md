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
  means the mutation tools are not registered at all.

The service refuses to start if a required setting is missing and names only the setting.

## Deploy

1. Register an Entra app (web platform, redirect URI `<base URL>/signin/callback`) and note the
   tenant ID, client ID and a client secret.
2. Create the resource group and deploy:

   ```powershell
   az group create -n rg-alexa-mcp -l westeurope
   az deployment group create -g rg-alexa-mcp -f infra/main.bicep -p namePrefix=alexamcp `
     entraTenantId=<tenant> entraClientId=<client> approvedRedirectUris=<comma-separated URIs>
   ```

3. Store the Entra client secret in the vault as `entra-client-secret` (your account needs
   *Key Vault Secrets Officer* for this step).
4. Set `OWNER_ACCOUNT_ID` and, when ready for the mutation window, `MUTATION_ALLOWED_TARGETS`:

   ```powershell
   az webapp config appsettings set -g rg-alexa-mcp -n <site> --settings OWNER_ACCOUNT_ID=<oid>
   ```

5. Publish the build. Stage `dist`, `package.json`, `package-lock.json` and `patches`, run
   `npm ci --omit=dev` in the staging folder (this applies the required upstream auth-guard patch;
   without `patches` the service fails closed and `/readyz` stays 503), zip it and deploy with
   `az webapp deploy --type zip --async true`. The first start takes several minutes. Check
   `GET /healthz` returns 200 and `GET /readyz` returns 200 once the session is seeded.
   Set `ALEXA_DIAG=1` temporarily to log a redacted backend failure message.

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
