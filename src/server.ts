import AlexaRemote from 'alexa-remote2';
import { AlexaAdapter, type AlexaProbeClient } from './alexa-adapter.js';
import { AlexaSessionBackend, type CookieHelper, type RemoteSessionClient } from './alexa-session-backend.js';
import { createAzureVault, KeyVaultSessionStore } from './keyvault-session-store.js';
import type { AlexaPort } from './ports.js';
import { cachedInventory } from './inventory-cache.js';
import { buildService, loadConfig } from './service.js';
import { SessionManager } from './session-manager.js';

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INVENTORY_MAX_AGE_MS = 10 * 60 * 1000;
const INVENTORY_REFRESH_MS = 4 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-require-imports -- untyped CommonJS helper
const cookie = require('alexa-cookie2') as CookieHelper;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const vaultUri = process.env.KEY_VAULT_URI?.trim();
  if (!vaultUri) throw new Error('Missing required settings: KEY_VAULT_URI');

  const vault = createAzureVault(vaultUri);
  const backend = new AlexaSessionBackend({
    remoteConstructor: AlexaRemote as unknown as ConstructorParameters<typeof AlexaSessionBackend>[0]['remoteConstructor'],
    cookieHelper: cookie,
  });
  const manager = new SessionManager(new KeyVaultSessionStore(vault), backend);

  // The adapter is bound to the live client, which exists only after the session initializes.
  const current = (): AlexaPort => {
    const client = backend.client as RemoteSessionClient | undefined;
    if (!client) throw new Error('Session unavailable');
    return new AlexaAdapter(client as unknown as AlexaProbeClient);
  };
  const inventory = cachedInventory(() => current().smartHomeDevices(), INVENTORY_MAX_AGE_MS);
  const port: AlexaPort = {
    echoDevices: () => current().echoDevices(),
    smartHomeDevices: () => inventory.read(),
    smartHomeGroups: () => current().smartHomeGroups(),
    routines: (limit) => current().routines(limit),
    deviceState: (id, entityType) => current().deviceState(id, entityType),
    dnd: () => current().dnd(),
    discover: () => current().discover(),
    controlDevice: (id, parameters) => current().controlDevice(id, parameters),
    runRoutine: (device, routine) => current().runRoutine(device, routine),
    setDnd: (device, enabled) => current().setDnd(device, enabled),
    speak: (serials, mode, text) => current().speak(serials, mode, text),
    setVolume: (serial, level) => current().setVolume(serial, level),
    lists: () => current().lists(),
    listItems: (listId, limit) => current().listItems(listId, limit),
    reminders: () => current().reminders(),
  };

  const service = await buildService(config, {
    vault,
    alexa: { port, health: () => manager.health, stop: () => backend.stop() },
  });
  await new Promise<void>((resolve) => service.server.listen(config.port, resolve));
  console.log('Alexa Remote MCP listening');

  await manager.initialize().catch(() => undefined);
  console.log(`Alexa session: ${manager.health}`);
  void inventory.refresh();
  const warm = setInterval(() => { void inventory.refresh(); }, INVENTORY_REFRESH_MS);
  warm.unref();
  const timer = setInterval(() => {
    void manager.refresh().catch(() => undefined).finally(() => console.log(`Alexa session: ${manager.health}`));
  }, REFRESH_INTERVAL_MS);
  timer.unref();

  const shutdown = () => {
    clearInterval(timer);
    service.server.close(() => { service.close(); process.exit(0); });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  // Only configuration errors carry safe, value-free messages.
  console.error(error instanceof Error && error.message.startsWith('Missing required') ? error.message : 'Service failed to start.');
  process.exit(1);
});
