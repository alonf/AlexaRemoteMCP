import type { JournalBegin, JournalRecord } from './journal.js';
import type { Outcome } from './outcomes.js';
import type { WriteResponse } from './write-outcome.js';

export type { SessionStore as CredentialStore } from './session-manager.js';

export interface AlexaPort {
  echoDevices(): Promise<unknown>;
  smartHomeDevices(): Promise<unknown>;
  smartHomeGroups(): Promise<unknown>;
  routines(limit: number): Promise<unknown>;
  deviceState(id: string, entityType?: string): Promise<unknown>;
  dnd(): Promise<unknown>;
  discover(): Promise<unknown>;
  controlDevice(id: string, parameters: unknown): Promise<WriteResponse>;
  runRoutine(device: string, routine: object): Promise<WriteResponse>;
  setDnd(device: string, enabled: boolean): Promise<WriteResponse>;
  speak(serials: string[], mode: 'speak' | 'announce', text: string): Promise<WriteResponse>;
  setVolume(serial: string, level: number): Promise<WriteResponse>;
  lists(): Promise<unknown>;
  listItems(listId: string, limit: number): Promise<unknown>;
  reminders(): Promise<unknown>;
}

export interface OperationStore {
  begin(operation: string, args: unknown, targets: string[], now?: Date): Promise<JournalBegin>;
  end(operationId: string, outcome: Outcome, now?: Date): Promise<void>;
  read(): Promise<JournalRecord[]>;
  recover(): Promise<JournalRecord[]>;
}
