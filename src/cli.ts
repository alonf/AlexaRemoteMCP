import type { AlexaAdapter } from './alexa-adapter.js';
import { checkApproval } from './approvals.js';
import { DndProbe, type DndBackend, type DndValue, type SnapshotStore } from './dnd-probe.js';
import type { DeviceDescriptor } from './excluded-devices.js';
import { hashArguments, Journal } from './journal.js';
import { LoginSetup } from './login-setup.js';
import { runMutationProbe } from './mutation-probe.js';
import { normalizeSimpleBody, normalizeWrite, type Outcome } from './outcomes.js';
import { readDeviceState, readInventory } from './read-probes.js';
import { routineDefinitionHash, runRoutineProbe } from './routine-probe.js';
import { Labeler, sanitizeEvidence } from './sanitizer.js';
import type { SessionManager } from './session-manager.js';

export interface Connected {
  adapter: AlexaAdapter;
  descriptorFor(entityId: string): Promise<DeviceDescriptor | undefined>;
}

export interface CliDeps {
  approvalFile: string;
  journal: Journal;
  snapshots: SnapshotStore;
  manager: SessionManager;
  loginSetup: LoginSetup;
  // Creates the live client; only called after every required approval is present.
  connect(): Promise<Connected>;
  print(text: string): void;
  saveMapping(mapping: Record<string, string>): Promise<void>;
  now(): Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

async function gate(deps: CliDeps, probe: string, targets: string[], args: unknown) {
  return checkApproval(deps.approvalFile, { probe, targets, args }, deps.now());
}

function dndBackend(adapter: AlexaAdapter): DndBackend {
  return {
    hasRevisionHistory: false,
    async read() {
      const body = await adapter.dnd();
      const list = isRecord(body) ? body.doNotDisturbDeviceStatusList : undefined;
      const result: Record<string, DndValue> = {};
      if (Array.isArray(list)) {
        for (const item of list) {
          if (isRecord(item) && typeof item.deviceSerialNumber === 'string') {
            result[item.deviceSerialNumber] = typeof item.enabled === 'boolean' ? item.enabled : 'unknown';
          }
        }
      }
      return result;
    },
    async write(device, enabled): Promise<Outcome> {
      return normalizeWrite(await adapter.setDnd(device, enabled), (body) => normalizeSimpleBody(body, device));
    },
  };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) throw new Error('Missing JSON argument');
  return JSON.parse(text) as unknown;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  const labeler = new Labeler();
  const emit = async (value: unknown) => {
    deps.print(JSON.stringify(sanitizeEvidence(value, labeler), null, 2));
    await deps.saveMapping(labeler.mapping()).catch(() => undefined);
  };
  const notRun = async (reason: string) => {
    await emit({ status: 'not_dispatched', reason });
    return 2;
  };

  try {
    switch (command) {
      case 'approval-template': {
        const [probe, targets, args] = rest;
        const parsed = parseJson(args ?? '{}');
        deps.print(JSON.stringify([{
          probe, targets: (targets ?? '').split(',').filter(Boolean), argumentsHash: hashArguments(parsed),
          notBefore: 'FILL_IN_ISO_TIME', expiresAt: 'FILL_IN_ISO_TIME',
        }], null, 2));
        return 0;
      }
      case 'status': {
        const records = await deps.journal.recover();
        const snapshot = await deps.snapshots.load();
        await emit({ health: deps.manager.health, journal: records.map((r) => ({ operation: r.operation, status: r.outcome?.status })), dndSnapshot: snapshot ? 'present' : 'none' });
        return 0;
      }
      case 'logout':
        await deps.manager.logout();
        await emit({ status: 'logged_out' });
        return 0;
      case 'login': {
        const amazonPage = rest[0];
        if (!amazonPage) return await notRun('missing_argument');
        const decision = await gate(deps, 'login-setup', [amazonPage], {});
        if (!decision.approved) return await notRun(`approval_${decision.reason}`);
        const { url, done } = await deps.loginSetup.start({ amazonPage, locale: rest[1] ?? 'en-US', ttlMs: 10 * 60 * 1000, ownerApproved: true });
        deps.print(`Sign in at ${url} (valid for 10 minutes; loopback only).`);
        await emit({ status: await done });
        return 0;
      }
      default:
        break;
    }

    const live = await prepareLive(command, rest, deps);
    if (live.error) return await notRun(live.error);
    const { connected } = live;
    if (!connected) return await notRun('unavailable');
    const adapter = connected.adapter;

    switch (command) {
      case 'refresh':
        await emit({ status: 'refreshed', health: deps.manager.health });
        return 0;
      case 'inventory':
        await emit(await readInventory(adapter, deps.now()));
        return 0;
      case 'find': {
        // Owner-only lookup: prints real names and IDs unsanitized to the terminal; never use as evidence.
        const needle = (rest[0] ?? '').toLowerCase();
        if (!needle) return await notRun('missing_argument');
        const sources: Array<[string, () => Promise<unknown>]> = [
          ['echo', () => adapter.echoDevices()],
          ['smartHome', () => adapter.smartHomeDevices()],
          ['routine', () => adapter.routines(2000)],
        ];
        for (const [family, read] of sources) {
          const body = await read();
          const list = Array.isArray(body) ? body : isRecord(body) ? Object.values(body).find(Array.isArray) ?? [] : [];
          for (const item of list as unknown[]) {
            if (!JSON.stringify(item).toLowerCase().includes(needle) || !isRecord(item)) continue;
            const fields = Object.entries(item)
              .filter(([, v]) => typeof v === 'string' && v.length <= 120)
              .map(([k, v]) => `${k}=${String(v)}`);
            const legacy = isRecord(item.legacyAppliance) ? item.legacyAppliance : {};
            const nested = ['applianceId', 'entityId'].flatMap((k) => (typeof legacy[k] === 'string' ? [`legacy.${k}=${legacy[k]}`] : []));
            const caps = Array.isArray(legacy.capabilities)
              ? (legacy.capabilities as unknown[]).flatMap((c) => {
                if (!isRecord(c) || typeof c.interfaceName !== 'string') return [];
                const props = isRecord(c.properties) ? c.properties : {};
                return [`${c.interfaceName}${props.retrievable === true ? '(retrievable)' : ''}`];
              })
              : [];
            const utterances = JSON.stringify(item).match(/"utterance":"[^"]*"/g) ?? [];
            deps.print(`[${family}] ${[...fields, ...nested, ...(caps.length ? [`caps=${caps.join(',')}`] : []), ...utterances].join(' | ')}`);
          }
        }
        return 0;
      }
      case 'state':
        await emit(await readDeviceState(adapter, rest[0] ?? '', deps.now(), rest[1]));
        return 0;
      case 'discover':
        await adapter.discover();
        await emit({ status: 'discovery_requested' });
        return 0;
      case 'shape': {
        // Structure only: key names and value types, never values.
        const skeleton = (v: unknown, depth = 0): unknown => {
          if (Array.isArray(v)) return depth > 5 ? 'array' : v.slice(0, 2).map((x) => skeleton(x, depth + 1));
          if (isRecord(v)) return depth > 5 ? 'object' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, skeleton(x, depth + 1)]));
          if (typeof v === 'string') {
            try {
              const inner: unknown = JSON.parse(v);
              if (inner !== null && typeof inner === 'object') return { jsonString: skeleton(inner, depth + 1) };
            } catch { /* plain string */ }
          }
          return typeof v;
        };
        deps.print(JSON.stringify(skeleton(await adapter.deviceState(rest[0] ?? '', rest[1]))));
        return 0;
      }
      case 'dnd-read':
        await emit({ fetchedAt: deps.now().toISOString(), devices: await dndBackend(adapter).read() });
        return 0;
      case 'dnd-apply': {
        const [desired, ...devices] = rest;
        const result = await new DndProbe(dndBackend(adapter), deps.snapshots).apply(devices, desired === 'true');
        await emit({ outcome: result.outcome, devices: result.snapshot?.devices });
        return 0;
      }
      case 'dnd-restore': {
        const result = await new DndProbe(dndBackend(adapter), deps.snapshots).restore({ ownerDirected: rest.includes('--owner-directed') });
        await emit({ outcome: result.outcome, devices: result.snapshot?.devices });
        return 0;
      }
      case 'routine-inspect': {
        const body = await adapter.routines(2000);
        const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.automations) ? body.automations : [];
        const routine = list.find((r) => isRecord(r) && r.automationId === rest[0]);
        if (routine && rest[1] === '--diff') {
          const again = (await adapter.routines(2000)) as unknown;
          const list2 = Array.isArray(again) ? again : isRecord(again) && Array.isArray(again.automations) ? again.automations : [];
          const other = list2.find((r) => isRecord(r) && r.automationId === rest[0]);
          const paths: string[] = [];
          const walk = (a: unknown, b: unknown, p: string): void => {
            if (isRecord(a) && isRecord(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${p}.${k}`); }
            else if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${p}[${i}]`); }
            else if (JSON.stringify(a) !== JSON.stringify(b)) paths.push(p);
          };
          walk(routine, other, '');
          deps.print(JSON.stringify({ differingPaths: paths }));
          return 0;
        }
        await emit(routine ? { found: true, definitionHash: routineDefinitionHash(routine) } : { found: false });
        return 0;
      }
      case 'routine': {
        const [routineId, device] = rest;
        const result = await runRoutineProbe(adapter, {
          routineId: routineId ?? '', device: device ?? '', approvalFile: deps.approvalFile, journal: deps.journal, now: deps.now(),
        });
        await emit(result);
        return result.ran ? 0 : 2;
      }
      case 'mutate': {
        const [entityId, parameters, expect] = rest;
        const result = await runMutationProbe(adapter, {
          entityId: entityId ?? '',
          descriptor: await connected.descriptorFor(entityId ?? ''),
          parameters: parseJson(parameters) as unknown[],
          ...(expect ? { expect: parseJson(expect) as never } : {}),
          approvalFile: deps.approvalFile, journal: deps.journal, now: deps.now(),
        });
        await emit(result);
        return result.ran ? 0 : 2;
      }
      default:
        deps.print('Unknown command');
        return 1;
    }
  } catch {
    deps.print(JSON.stringify({ status: 'failed' }));
    return 1;
  }
}

// Every live command needs a session approval and its own probe approval before the first Amazon call.
async function prepareLive(command: string | undefined, rest: string[], deps: CliDeps): Promise<{ error?: string; connected?: Connected }> {
  const required: Record<string, { probe: string; targets: string[]; args: unknown } | undefined> = {
    refresh: { probe: 'session-refresh', targets: ['session'], args: {} },
    inventory: { probe: 'inventory-read', targets: ['inventory'], args: {} },
    find: { probe: 'inventory-read', targets: ['inventory'], args: {} },
    discover: { probe: 'discovery', targets: ['smart-home'], args: {} },
    state: { probe: 'state-read', targets: [rest[0] ?? ''], args: { id: rest[0] } },
    shape: { probe: 'state-read', targets: [rest[0] ?? ''], args: { id: rest[0] } },
    'dnd-read': { probe: 'dnd-read', targets: ['dnd'], args: {} },
    'dnd-apply': { probe: 'dnd-write', targets: rest.slice(1), args: { desired: rest[0] === 'true' } },
    'dnd-restore': { probe: 'dnd-restore', targets: ['snapshot'], args: { ownerDirected: rest.includes('--owner-directed') } },
    'routine-inspect': { probe: 'routine-inspect', targets: [rest[0] ?? ''], args: {} },
    routine: { probe: 'routine-inspect', targets: [rest[0] ?? ''], args: {} },
    mutate: { probe: 'device-inspect', targets: [rest[0] ?? ''], args: {} },
  };
  const spec = command ? required[command] : undefined;
  if (!spec) return { error: 'unknown_command' };

  const session = await gate(deps, command === 'refresh' ? 'session-refresh' : 'session-init', ['session'], {});
  if (!session.approved) return { error: `approval_${session.reason}` };
  if (command !== 'refresh') {
    const probe = await gate(deps, spec.probe, spec.targets, spec.args);
    if (!probe.approved) return { error: `approval_${probe.reason}` };
  }

  const connected = await deps.connect();
  if (command === 'refresh') await deps.manager.refresh();
  return { connected };
}
