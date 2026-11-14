import net from 'node:net';
import type { SessionStore } from './session-manager.js';

type Callback = (error: Error | null, result?: unknown) => void;

export interface LoginHelper {
  generateAlexaCookie(options: Record<string, unknown>, callback: Callback): void;
  stopProxyServer(callback?: () => void): void;
}

export type LoginSetupState = 'idle' | 'listening' | 'completed' | 'cancelled' | 'expired' | 'failed';

export interface LoginSetupOptions {
  amazonPage: string;
  locale?: string;
  host?: string;
  port?: number;
  ttlMs: number;
  ownerApproved: boolean;
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
}

export class LoginSetup {
  private current: LoginSetupState = 'idle';
  private timer: NodeJS.Timeout | undefined;
  private finish: ((state: LoginSetupState) => void) | undefined;

  constructor(
    private readonly helper: LoginHelper,
    private readonly store: SessionStore,
  ) {}

  get state(): LoginSetupState {
    return this.current;
  }

  // Resolves with the loopback URL once the local sign-in page is listening.
  start(setup: LoginSetupOptions): Promise<{ url: string; done: Promise<LoginSetupState> }> {
    const host = setup.host ?? '127.0.0.1';
    if (!setup.ownerApproved) return Promise.reject(new Error('Login setup requires owner approval'));
    if (!isLoopbackHost(host)) return Promise.reject(new Error('Login setup is restricted to loopback'));
    if (this.current === 'listening') return Promise.reject(new Error('Login setup already active'));
    if (!Number.isFinite(setup.ttlMs) || setup.ttlMs <= 0) return Promise.reject(new Error('Invalid login setup lifetime'));

    const locale = setup.locale ?? 'en-US';
    if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale)) return Promise.reject(new Error('Invalid locale'));

    this.current = 'listening';
    const options: Record<string, unknown> = {
      amazonPage: setup.amazonPage,
      acceptLanguage: locale,
      amazonPageProxyLanguage: locale.replace('-', '_'),
      setupProxy: true,
      proxyOnly: true,
      proxyOwnIp: host,
      proxyListenBind: host,
      proxyPort: setup.port ?? 0,
      proxyLogLevel: 'silent',
    };

    return new Promise((resolveStart, rejectStart) => {
      let started = false;
      let resolveDone!: (state: LoginSetupState) => void;
      const done = new Promise<LoginSetupState>((resolve) => { resolveDone = resolve; });
      const end = (state: LoginSetupState) => {
        if (this.current !== 'listening') return;
        this.current = state;
        clearTimeout(this.timer);
        this.finish = undefined;
        this.helper.stopProxyServer();
        resolveDone(state);
      };
      this.finish = end;
      this.timer = setTimeout(() => end('expired'), setup.ttlMs);

      const onCallback: Callback = (error, result) => {
        // Callbacks after expiry or cancellation are dropped and never persisted.
        if (this.current !== 'listening') return;
        if (!started && error && /Please open http/i.test(error.message)) {
          started = true;
          resolveStart({ url: `http://${host.includes(':') ? `[${host}]` : host}:${String(options.proxyPort)}/`, done });
          return;
        }
        if (error || result === null || typeof result !== 'object') {
          end('failed');
          if (!started) rejectStart(new Error('Login setup failed'));
          return;
        }
        // Past this point the sign-in succeeded; expiry and cancellation can no longer race the save.
        clearTimeout(this.timer);
        this.finish = undefined;
        this.store.save(result).then(
          () => end('completed'),
          () => end('failed'),
        );
      };

      try {
        this.helper.generateAlexaCookie(options, onCallback);
      } catch {
        end('failed');
        rejectStart(new Error('Login setup failed'));
      }
    });
  }

  cancel(): void {
    this.finish?.('cancelled');
  }
}
