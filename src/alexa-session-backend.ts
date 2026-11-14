import { ReauthenticationRequiredError, type SessionBackend } from './session-manager.js';
import { guardedOptions } from './auth-guard.js';

type Callback = (error: Error | null, result?: unknown) => void;

export interface RemoteSessionClient {
  init(options: object, callback: Callback): void;
  stop(): void;
  cookieData?: unknown;
}

export interface CookieHelper {
  refreshAlexaCookie(options: object, callback: Callback): void;
}

export interface AlexaSessionLibraries {
  remoteConstructor: (new () => RemoteSessionClient) & { connectivityProofAuthGuardVersion?: number };
  cookieHelper: CookieHelper;
}

type SessionData = Record<string, unknown> & { amazonPage?: string };

// Only failures that prove Amazon rejected the credentials need a new owner login;
// everything else (network, timeout, malformed response) is retryable.
const REJECTION = /No new access token|No former registration data|Authentication rejected|Refresh failed|401|403/i;

function classify(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  return REJECTION.test(message) ? new ReauthenticationRequiredError() : new Error('Session backend failed');
}

function asSession(value: unknown): SessionData {
  if (value === null || typeof value !== 'object') throw new Error('Session backend failed');
  return value as SessionData;
}

export class AlexaSessionBackend implements SessionBackend {
  private remote: RemoteSessionClient | undefined;

  constructor(private readonly libraries: AlexaSessionLibraries) {}

  get client(): RemoteSessionClient | undefined {
    return this.remote;
  }

  stop(): void {
    this.remote?.stop();
    this.remote = undefined;
  }

  initialize(session: unknown): Promise<unknown> {
    const data = asSession(session);
    this.stop();
    const remote = new this.libraries.remoteConstructor();
    const options = guardedOptions(this.libraries.remoteConstructor, {
      cookie: data,
      formerRegistrationData: data,
      amazonPage: data.amazonPage,
    });
    return new Promise((resolve, reject) => {
      try {
        remote.init(options, (error) => {
          if (error) {
            remote.stop();
            return reject(classify(error));
          }
          this.remote = remote;
          const current = remote.cookieData;
          resolve(current !== null && typeof current === 'object' ? { ...data, ...current } : data);
        });
      } catch {
        remote.stop();
        reject(new Error('Session backend failed'));
      }
    });
  }

  refresh(session: unknown): Promise<unknown> {
    const data = asSession(session);
    const options = guardedOptions(this.libraries.remoteConstructor, {
      formerRegistrationData: data,
      amazonPage: data.amazonPage,
    });
    return new Promise((resolve, reject) => {
      try {
        this.libraries.cookieHelper.refreshAlexaCookie(options, (error, result) => {
          if (error || result === null || typeof result !== 'object') return reject(classify(error));
          resolve({ ...data, ...result });
        });
      } catch {
        reject(new Error('Session backend failed'));
      }
    });
  }
}
