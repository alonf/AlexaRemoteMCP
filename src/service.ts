import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { exportJWK, generateKeyPair } from 'jose';
import { CatalogError, CatalogStore, loadCatalogFile } from './catalog.js';
import { ADMIN_PAGE_PATH, createAdminHandler } from './admin-api.js';
import { type BackupFn, createBlobBackup, throttleBackup } from './catalog-backup.js';
import { CatalogService } from './catalog-service.js';
import { type ActionModes, ActionPolicyError, CATEGORIES, parseActionPolicy } from './action-policy.js';
import { ApprovalSigner } from './approval.js';
import { createHttpServer, MCP_PATH } from './http-server.js';
import { createIssuer } from './issuer.js';
import type { VaultClient } from './keyvault-session-store.js';
import { KeyVaultSessionStore } from './keyvault-session-store.js';
import { MutationService } from './mutation-service.js';
import { OidcSignIn } from './oidc-sign-in.js';
import { OidcStore } from './oidc-store.js';
import type { AlexaPort } from './ports.js';
import type { SessionHealth } from './session-manager.js';
import { SqliteJournal } from './sqlite-journal.js';

export interface ServiceConfig {
  port: number;
  publicBaseUrl: string;
  journalPath: string;
  catalogPath: string;
  catalogBackupUrl?: string;
  catalogBackupContainer: string;
  oidcStorePath: string;
  entraTenantId: string;
  entraClientId: string;
  entraClientSecret?: string;
  approvedRedirectUris: string[];
  ownerAccountId: string;
  mutationTargets: string[];
  actionModes?: ActionModes;
}

export class ConfigError extends Error {}

const REQUIRED = [
  'PUBLIC_BASE_URL',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'OWNER_ACCOUNT_ID',
  'APPROVED_REDIRECT_URIS',
] as const;

const list = (value: string | undefined) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

// Names only in the error: values may be private and must never reach logs.
export function loadConfig(env: NodeJS.ProcessEnv): ServiceConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new ConfigError(`Missing required settings: ${missing.join(', ')}`);
  const base = (env.PUBLIC_BASE_URL as string).trim().replace(/\/$/, '');
  if (!base.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    throw new ConfigError('PUBLIC_BASE_URL must be https');
  }
  const home = env.HOME_DATA_DIR ?? '/home/data';
  const secret = env.ENTRA_CLIENT_SECRET?.trim();
  let actionModes: ActionModes | undefined;
  if (env.ACTION_POLICY?.trim()) {
    try {
      actionModes = parseActionPolicy(env.ACTION_POLICY);
    } catch (error) {
      throw new ConfigError(error instanceof ActionPolicyError ? error.message : 'ACTION_POLICY is invalid');
    }
  }
  return {
    port: Number(env.PORT ?? 8080),
    publicBaseUrl: base,
    journalPath: env.JOURNAL_PATH ?? `${home}/journal.sqlite`,
    catalogPath: env.CATALOG_PATH ?? `${home}/device-catalog.json`,
    ...(env.CATALOG_BACKUP_URL?.trim() ? { catalogBackupUrl: env.CATALOG_BACKUP_URL.trim() } : {}),
    catalogBackupContainer: env.CATALOG_BACKUP_CONTAINER?.trim() || 'catalog-backups',
    oidcStorePath: env.OIDC_STORE_PATH ?? `${home}/oidc.sqlite`,
    entraTenantId: (env.ENTRA_TENANT_ID as string).trim(),
    entraClientId: (env.ENTRA_CLIENT_ID as string).trim(),
    ...(secret ? { entraClientSecret: secret } : {}),
    approvedRedirectUris: list(env.APPROVED_REDIRECT_URIS),
    ownerAccountId: (env.OWNER_ACCOUNT_ID as string).trim(),
    mutationTargets: list(env.MUTATION_ALLOWED_TARGETS),
    ...(actionModes ? { actionModes } : {}),
  };
}

export interface AlexaRuntime {
  port: AlexaPort;
  health: () => SessionHealth;
  stop: () => void;
}

export interface ServiceDeps {
  vault: VaultClient;
  alexa: AlexaRuntime;
  fetchImpl?: typeof fetch;
  // Overrides the blob backup built from CATALOG_BACKUP_URL (used by tests).
  catalogBackup?: BackupFn;
}

interface IssuerKeys {
  signingKey: Record<string, unknown>;
  cookieKeys: string[];
}

// Signing and cookie keys live in Key Vault so tokens survive restarts and redeploys.
async function loadIssuerKeys(vault: VaultClient): Promise<IssuerKeys> {
  const store = new KeyVaultSessionStore(vault, 'issuer-keys');
  const existing = await store.load() as IssuerKeys | null;
  if (existing?.signingKey && Array.isArray(existing.cookieKeys)) return existing;
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const keys: IssuerKeys = {
    signingKey: { ...(await exportJWK(privateKey)), alg: 'RS256', use: 'sig', kid: randomBytes(8).toString('hex') },
    cookieKeys: [randomBytes(32).toString('hex')],
  };
  await store.save(keys);
  return keys;
}

// Signs MRTR approval state. Losing it only invalidates approvals that are still waiting for an answer.
async function loadApprovalKey(vault: VaultClient): Promise<Buffer> {
  const store = new KeyVaultSessionStore(vault, 'approval-key');
  const existing = await store.load() as { key?: string } | null;
  if (typeof existing?.key === 'string' && existing.key.length >= 64) return Buffer.from(existing.key, 'hex');
  const key = randomBytes(32);
  await store.save({ key: key.toString('hex') });
  return key;
}

export async function buildService(config: ServiceConfig, deps: ServiceDeps): Promise<{ server: Server; close: () => void }> {
  const keys = await loadIssuerKeys(deps.vault);
  const oidcStore = new OidcStore(config.oidcStorePath);
  const journal = new SqliteJournal(config.journalPath);
  journal.recoverOnStart();

  const signIn = new OidcSignIn({
    issuerUrl: `https://login.microsoftonline.com/${config.entraTenantId}/v2.0`,
    clientId: config.entraClientId,
    ...(config.entraClientSecret ? { clientSecret: async () => config.entraClientSecret as string } : {}),
    redirectUri: `${config.publicBaseUrl}/signin/callback`,
    accountClaim: 'oid',
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const issuer = createIssuer({
    baseUrl: config.publicBaseUrl,
    resource: `${config.publicBaseUrl}${MCP_PATH}`,
    approvedRedirectUris: config.approvedRedirectUris,
    adminRedirectUri: `${config.publicBaseUrl}${ADMIN_PAGE_PATH}`,
    ownerAccountId: config.ownerAccountId,
    store: oidcStore,
    signingKey: keys.signingKey as never,
    cookieKeys: keys.cookieKeys,
    signIn,
    trustProxy: true,
  });

  const modes = config.actionModes;
  // An invalid catalog stops startup: falling back to class-only categories could widen or narrow access silently.
  let catalog;
  try {
    catalog = new CatalogStore(loadCatalogFile(config.catalogPath), config.catalogPath);
  } catch (error) {
    throw new ConfigError(error instanceof CatalogError ? error.message : 'device catalog could not be read');
  }
  const catalogEnabled = modes !== undefined || catalog.get().size > 0;
  const mutates = catalogEnabled
    || (modes ? CATEGORIES.some((category) => category !== 'query' && modes[category] !== 'deny') : config.mutationTargets.length > 0);
  // Catalog edits always need the signer, whatever the category modes are.
  const needsApproval = catalogEnabled || (modes !== undefined && CATEGORIES.some((category) => modes[category] === 'approve'));
  const approvals = needsApproval ? new ApprovalSigner(await loadApprovalKey(deps.vault)) : undefined;
  // With ACTION_POLICY set and no device list, the modes alone decide; a list only narrows them.
  const allowedTargets = new Set(config.mutationTargets.length > 0 ? config.mutationTargets : ['*']);
  const mutations = mutates
    ? new MutationService(
      deps.alexa.port, journal, { allowedTargets, catalog, ...(modes ? { modes } : {}) },
      undefined, undefined, undefined, undefined, approvals,
    )
    : undefined;
  // Pre-edit snapshots go to blob storage; an edit is refused if the snapshot cannot be taken.
  const backup = deps.catalogBackup
    ?? (config.catalogBackupUrl
      ? throttleBackup(createBlobBackup(config.catalogBackupUrl, config.catalogBackupContainer), 5 * 60 * 1000)
      : undefined);
  const catalogService = new CatalogService(catalog, journal, approvals, undefined, backup);
  const admin = createAdminHandler({
    baseUrl: config.publicBaseUrl,
    authenticate: (request) => issuer.authenticateAdmin(request),
    catalog: catalogService,
    adapter: deps.alexa.port,
    sessionHealth: deps.alexa.health,
  });
  const server = createHttpServer({
    adapter: deps.alexa.port,
    sessionHealth: deps.alexa.health,
    authenticate: (request) => issuer.authenticate(request),
    allowedOrigins: [],
    resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
    fallback: async (request, response) => {
      if (!(await admin(request, response))) await issuer.handle(request, response);
    },
    ...(mutations ? { mutations } : {}),
    ...(catalogEnabled ? { catalog: catalogService } : {}),
    ...(modes ? { readsAllowed: modes.query === 'allow' } : {}),
  });
  return {
    server,
    close: () => {
      deps.alexa.stop();
      oidcStore.close();
      journal.close();
    },
  };
}
