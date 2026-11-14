import fs from 'node:fs/promises';
import path from 'node:path';
import AlexaRemote from 'alexa-remote2';
import { AlexaAdapter, type AlexaProbeClient } from './alexa-adapter.js';
import { AlexaSessionBackend, type CookieHelper, type RemoteSessionClient } from './alexa-session-backend.js';
import { runCli, type Connected } from './cli.js';
import { CredentialStore } from './credential-store.js';
import type { DeviceDescriptor } from './excluded-devices.js';
import { Journal } from './journal.js';
import { FileSnapshotStore } from './dnd-probe.js';
import { LoginSetup, type LoginHelper } from './login-setup.js';
import { SessionManager } from './session-manager.js';

const home: string = process.env.ALEXA_PROOF_HOME ?? '';
if (!home) {
  console.error('Set ALEXA_PROOF_HOME to a protected directory outside the repository.');
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- untyped CommonJS helper
const cookie = require('alexa-cookie2') as CookieHelper & LoginHelper;
async function main(): Promise<void> {
  const store = await CredentialStore.open(home);
  const backend = new AlexaSessionBackend({
    remoteConstructor: AlexaRemote as unknown as ConstructorParameters<typeof AlexaSessionBackend>[0]['remoteConstructor'],
    cookieHelper: cookie,
  });
  const manager = new SessionManager(store, backend);
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  async function connect(): Promise<Connected> {
    await manager.initialize();
    const client = backend.client as RemoteSessionClient | undefined;
    if (!client) throw new Error('No client');
    const adapter = new AlexaAdapter(client as unknown as AlexaProbeClient);
    return {
      adapter,
      async descriptorFor(entityId): Promise<DeviceDescriptor | undefined> {
        const body = await adapter.smartHomeDevices();
        const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.smarthomeDevices) ? body.smarthomeDevices : [];
        const legacyOf = (item: unknown): Record<string, unknown> => (isRecord(item) && isRecord(item.legacyAppliance) ? item.legacyAppliance : {});
        const found = list.find((item) => isRecord(item)
          && [item.entityId, item.applianceId, item.id, legacyOf(item).applianceId, legacyOf(item).entityId].includes(entityId));
        if (!isRecord(found)) return undefined;
        // Endpoint records keep the class fields under legacyAppliance and displayCategories.
        const legacy = legacyOf(found);
        const category = isRecord(found.displayCategories) && isRecord(found.displayCategories.primary) ? found.displayCategories.primary.value : undefined;
        return { ...found, applianceTypes: found.applianceTypes ?? legacy.applianceTypes, capabilities: found.capabilities ?? legacy.capabilities, deviceType: found.deviceType ?? category };
      },
    };
  }

  const code = await runCli(process.argv.slice(2), {
    approvalFile: path.join(home, 'approvals.json'),
    journal: new Journal(path.join(home, 'journal.jsonl')),
    snapshots: new FileSnapshotStore(path.join(home, 'dnd-snapshot.json')),
    manager,
    loginSetup: new LoginSetup(cookie, store),
    connect,
    print: (text) => console.log(text),
    saveMapping: (mapping) => fs.writeFile(path.join(home, 'mapping.json'), JSON.stringify(mapping, null, 2), { mode: 0o600 }),
    now: () => new Date(),
  });
  backend.stop();
  process.exit(code);
}

main().catch(() => {
  console.error('Proof runner failed to start.');
  process.exit(1);
});
