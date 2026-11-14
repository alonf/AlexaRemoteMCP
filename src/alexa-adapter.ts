import { awaitWriteResponse } from './write-outcome.js';

type Callback = (error: Error | null, body?: unknown) => void;

export interface AlexaProbeClient {
  getDevices(callback: Callback): void;
  getSmarthomeDevicesV2(callback: Callback): void;
  getSmarthomeGroups(callback: Callback): void;
  getAutomationRoutines(limit: number, callback: Callback): void;
  querySmarthomeDevices(ids: string[], type: string, timeout: number, callback: Callback): void;
  getDoNotDisturb(callback: Callback): void;
  discoverSmarthomeDevice(callback: Callback): void;
  executeSmarthomeDeviceAction(ids: string[], parameters: unknown[], type: string, callback: Callback): void;
  executeAutomationRoutine(device: string, routine: object, callback: Callback): void;
  setDoNotDisturb(device: string, enabled: boolean, callback: Callback): void;
}

function read(invoke: (callback: Callback) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    try {
      invoke((error, body) => error ? reject(new Error('Alexa read failed')) : resolve(body));
    } catch {
      reject(new Error('Alexa read failed'));
    }
  });
}

export class AlexaAdapter {
  constructor(private readonly client: AlexaProbeClient) {}

  echoDevices(): Promise<unknown> {
    return read((callback) => this.client.getDevices(callback));
  }

  smartHomeDevices(): Promise<unknown> {
    return read((callback) => this.client.getSmarthomeDevicesV2(callback));
  }

  smartHomeGroups(): Promise<unknown> {
    return read((callback) => this.client.getSmarthomeGroups(callback));
  }

  routines(limit: number): Promise<unknown> {
    return read((callback) => this.client.getAutomationRoutines(limit, callback));
  }

  deviceState(id: string, entityType = 'APPLIANCE'): Promise<unknown> {
    return read((callback) => this.client.querySmarthomeDevices([id], entityType, 15000, callback));
  }

  dnd(): Promise<unknown> {
    return read((callback) => this.client.getDoNotDisturb(callback));
  }

  discover(): Promise<unknown> {
    return read((callback) => this.client.discoverSmarthomeDevice(callback));
  }

  controlDevice(id: string, parameters: unknown[]) {
    return awaitWriteResponse((callback) => this.client.executeSmarthomeDeviceAction(
      [id], parameters, 'APPLIANCE', callback,
    ));
  }

  runRoutine(device: string, routine: object) {
    return awaitWriteResponse((callback) => this.client.executeAutomationRoutine(device, routine, callback));
  }

  setDnd(device: string, enabled: boolean) {
    return awaitWriteResponse((callback) => this.client.setDoNotDisturb(device, enabled, callback));
  }
}
