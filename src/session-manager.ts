export interface SessionStore {
  load(): Promise<unknown | null>;
  save(data: unknown): Promise<void>;
  remove(): Promise<void>;
}

export interface SessionBackend {
  initialize(session: unknown): Promise<unknown>;
  refresh(session: unknown): Promise<unknown>;
}

export class ReauthenticationRequiredError extends Error {}

export type SessionHealth =
  | 'unauthenticated'
  | 'usable'
  | 'reauthentication_required'
  | 'persistence_failed'
  | 'temporarily_unavailable';

export class SessionManager {
  private inFlight: Promise<void> | undefined;
  private session: unknown | null = null;
  private logoutPending: Promise<void> | undefined;
  private state: SessionHealth = 'unauthenticated';

  constructor(
    private readonly store: SessionStore,
    private readonly backend: SessionBackend,
  ) {}

  get health(): SessionHealth {
    return this.state;
  }

  initialize(): Promise<void> {
    return this.ownOperation((session) => this.backend.initialize(session));
  }

  refresh(): Promise<void> {
    return this.ownOperation((session) => this.backend.refresh(session));
  }

  logout(): Promise<void> {
    if (this.logoutPending) return this.logoutPending;
    const pending = (async () => {
      if (this.inFlight) await this.inFlight.catch(() => undefined);
      try {
        await this.store.remove();
        this.session = null;
        this.state = 'unauthenticated';
      } catch {
        this.session = null;
        this.state = 'persistence_failed';
        throw new Error('Local logout failed');
      }
    })();
    this.logoutPending = pending;
    void pending.finally(() => {
      if (this.logoutPending === pending) this.logoutPending = undefined;
    }).catch(() => undefined);
    return pending;
  }

  private ownOperation(operation: (session: unknown) => Promise<unknown>): Promise<void> {
    if (this.logoutPending || this.state === 'reauthentication_required') {
      return Promise.reject(new Error('Session operation unavailable'));
    }
    if (this.inFlight) return this.inFlight;
    const pending = (async () => {
      let session: unknown;
      try {
        session = this.session ?? await this.store.load();
      } catch {
        this.state = 'persistence_failed';
        throw new Error('Session operation failed');
      }
      if (session === null) {
        this.state = 'unauthenticated';
        throw new Error('Session operation failed');
      }
      let refreshed: unknown = null;
      let failure: 'reauthentication_required' | 'temporarily_unavailable' | undefined;
      try {
        refreshed = await operation(session);
      } catch (error) {
        failure = error instanceof ReauthenticationRequiredError
          ? 'reauthentication_required'
          : 'temporarily_unavailable';
      }
      if (failure || refreshed === null || typeof refreshed !== 'object') {
        this.session = null;
        this.state = failure ?? 'temporarily_unavailable';
        throw new Error('Session operation failed');
      }
      try {
        await this.store.save(refreshed);
      } catch {
        this.session = null;
        this.state = 'persistence_failed';
        throw new Error('Session operation failed');
      }
      this.session = refreshed;
      this.state = 'usable';
    })();
    this.inFlight = pending;
    void pending.finally(() => {
      if (this.inFlight === pending) this.inFlight = undefined;
    }).catch(() => undefined);
    return pending;
  }
}
