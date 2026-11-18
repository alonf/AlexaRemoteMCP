import type { AlexaPort } from '../../src/ports.js';
import type { WriteResponse } from '../../src/write-outcome.js';

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeAlexaOptions {
  devices?: unknown;
  state?: Record<string, unknown>;
  write?: (call: FakeCall) => Promise<WriteResponse> | WriteResponse;
  echo?: unknown;
  lists?: unknown;
  listItems?: Record<string, unknown>;
  reminders?: unknown;
}

export class FakeAlexa implements AlexaPort {
  readonly calls: FakeCall[] = [];

  constructor(private readonly options: FakeAlexaOptions = {}) {}

  private record(method: string, args: unknown[]): FakeCall {
    const call = { method, args };
    this.calls.push(call);
    return call;
  }

  private async write(method: string, args: unknown[]): Promise<WriteResponse> {
    const call = this.record(method, args);
    if (this.options.write) return this.options.write(call);
    return {
      status: 'response_received',
      body: { controlResponses: [{ entityId: String(args[0]), code: 'SUCCESS' }] },
    };
  }

  async echoDevices() { this.record('echoDevices', []); return this.options.echo ?? { devices: [] }; }
  async smartHomeDevices() { this.record('smartHomeDevices', []); return this.options.devices ?? {}; }
  async smartHomeGroups() { this.record('smartHomeGroups', []); return {}; }
  async routines(limit: number) { this.record('routines', [limit]); return []; }
  async deviceState(id: string) { this.record('deviceState', [id]); return this.options.state?.[id] ?? {}; }
  async dnd() { this.record('dnd', []); return {}; }
  async discover() { this.record('discover', []); return {}; }
  async lists() { this.record('lists', []); return this.options.lists ?? []; }
  async listItems(listId: string, limit: number) { this.record('listItems', [listId, limit]); return this.options.listItems?.[listId] ?? []; }
  async reminders() { this.record('reminders', []); return this.options.reminders ?? { notifications: [] }; }
  controlDevice(id: string, parameters: unknown[]) { return this.write('controlDevice', [id, parameters]); }
  runRoutine(device: string, routine: object) { return this.write('runRoutine', [device, routine]); }
  setDnd(device: string, enabled: boolean) { return this.write('setDnd', [device, enabled]); }
  speak(serials: string[], mode: string, text: string) { return this.write('speak', [serials, mode, text]); }

  get writes(): FakeCall[] {
    return this.calls.filter((c) => ['controlDevice', 'runRoutine', 'setDnd', 'speak'].includes(c.method));
  }
}
