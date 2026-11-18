import type { AlexaPort } from './ports.js';
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
  executeSmarthomeDeviceAction(ids: string[], parameters: unknown, type: string, callback: Callback): void;
  executeAutomationRoutine(device: string, routine: object, callback: Callback): void;
  setDoNotDisturb(device: string, enabled: boolean, callback: Callback): void;
  sendSequenceCommand(serialOrName: string | string[], command: string, value: unknown, callback: Callback): void;
  getListsV2(callback: Callback): void;
  getListItemsV2(listId: string, options: { limit: number }, callback: Callback): void;
  getNotifications(cached: boolean, callback: Callback): void;
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

export class AlexaAdapter implements AlexaPort {
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

  lists(): Promise<unknown> {
    return read((callback) => this.client.getListsV2(callback));
  }

  listItems(listId: string, limit: number): Promise<unknown> {
    return read((callback) => this.client.getListItemsV2(listId, { limit }, callback));
  }

  reminders(): Promise<unknown> {
    return read((callback) => this.client.getNotifications(false, callback));
  }

  controlDevice(id: string, parameters: unknown) {
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

  // `speak` says the text on one device; `announce` plays it on every listed device, with Alexa's announcement chime.
  speak(serials: string[], mode: 'speak' | 'announce', text: string) {
    return awaitWriteResponse((callback) => this.client.sendSequenceCommand(
      mode === 'speak' ? (serials[0] as string) : serials, mode === 'speak' ? 'speak' : 'announcement', text, callback,
    ));
  }

  setVolume(serial: string, level: number) {
    return awaitWriteResponse((callback) => this.client.sendSequenceCommand(serial, 'volume', level, callback));
  }
}
