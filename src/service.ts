import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { exportJWK, generateKeyPair } from 'jose';
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
  oidcStorePath: string;
  entraTenantId: string;
  entraClientId: string;
  entraClientSecret?: string;
  approvedRedirectUris: string[];
  ownerAccountId: string;
  mutationTargets: string[];
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
  return {
    port: Number(env.PORT ?? 8080),
    publicBaseUrl: base,
    journalPath: env.JOURNAL_PATH ?? `${home}/journal.sqlite`,
    oidcStorePath: env.OIDC_STORE_PATH ?? `${home}/oidc.sqlite`,
    entraTenantId: (env.ENTRA_TENANT_ID as string).trim(),
    entraClientId: (env.ENTRA_CLIENT_ID as string).trim(),
    ...(secret ? { entraClientSecret: secret } : {}),
    approvedRedirectUris: list(env.APPROVED_REDIRECT_URIS),
    ownerAccountId: (env.OWNER_ACCOUNT_ID as string).trim(),
    mutationTargets: list(env.MUTATION_ALLOWED_TARGETS),
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
    ownerAccountId: config.ownerAccountId,
    store: oidcStore,
    signingKey: keys.signingKey as never,
    cookieKeys: keys.cookieKeys,
    signIn,
    trustProxy: true,
  });

  const mutations = config.mutationTargets.length > 0
    ? new MutationService(deps.alexa.port, journal, { allowedTargets: new Set(config.mutationTargets) })
    : undefined;

  const server = createHttpServer({
    adapter: deps.alexa.port,
    sessionHealth: deps.alexa.health,
    authenticate: (request) => issuer.authenticate(request),
    allowedOrigins: [],
    resourceMetadataUrl: `${config.publicBaseUrl}/.well-known/oauth-protected-resource`,
    fallback: (request, response) => issuer.handle(request, response),
    ...(mutations ? { mutations } : {}),
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
