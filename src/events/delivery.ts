import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CallbackError, hostAllowed } from './callback-transport.js';
import type { CallbackTransport } from './callback-transport.js';
import { signedHeaders, signingKeyOf } from './webhook-signature.js';
import type { Subscription, SubscriptionStore } from './subscriptions.js';
import { subscriptionId } from './subscriptions.js';

export const SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_SUBSCRIPTION_TTL_MS = 60_000;
export const RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

export interface EventTypeDescription {
  name: string;
  description: string;
  delivery: string[];
  inputSchema: Record<string, unknown>;
  payloadSchema: Record<string, unknown>;
}

const payloadSchema = (properties: Record<string, unknown>): Record<string, unknown> => ({
  type: 'object',
  properties: { eventId: { type: 'string' }, name: { type: 'string' }, timestamp: { type: 'string' }, data: { type: 'object', properties } },
});

export const EVENT_TYPES: readonly EventTypeDescription[] = [
  {
    name: 'approval.requested',
    description: 'A device action is waiting for the owner\'s approval. Only a doorbell: tell the owner what is waiting and ask whether to go ahead. Never approve for them.',
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {} },
    payloadSchema: payloadSchema({ summary: { type: 'string' }, action: { type: 'string' } }),
  },
  {
    name: 'session.attention',
    description: 'The Alexa session needs attention, for example a new sign-in. Only a doorbell: tell the owner.',
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {} },
    payloadSchema: payloadSchema({ summary: { type: 'string' }, health: { type: 'string' } }),
  },
  {
    name: 'action.completed',
    description: 'A device action finished (accepted, verified, failed or unknown). Only a doorbell: tell the owner the result. Accepted is not proof the device moved.',
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {} },
    payloadSchema: payloadSchema({ summary: { type: 'string' }, status: { type: 'string' } }),
  },
  {
    name: 'speech.urgent',
    description: 'The agent announced an urgent message on an Echo without approval, for an owner-listed reason. Only a doorbell: tell the owner it happened and why.',
    delivery: ['webhook'],
    inputSchema: { type: 'object', properties: {} },
    payloadSchema: payloadSchema({ summary: { type: 'string' }, reason: { type: 'string' } }),
  },
];

export type DeliveryErrorKind = 'invalid' | 'callback_failed';

export class DeliveryError extends Error {
  constructor(readonly kind: DeliveryErrorKind, readonly reason: string, message: string) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export interface SubscribeRequest {
  clientId: string;
  name: string;
  mode: string;
  url: string;
  secret: string;
  ttlMs?: number | null | undefined;
}

export interface DeliveryOptions {
  store: SubscriptionStore;
  transport: CallbackTransport;
  allowedHosts: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  log?: (line: string) => void;
}

// A short, stable hash of a client id for logs; the id itself can be a URL.
const clientRef = (clientId: string): string => createHash('sha256').update(clientId).digest('hex').slice(0, 16);

const accepted = (status: number): boolean => status >= 200 && status <= 299;
const retryable = (status: number): boolean => status === 408 || status === 425 || status === 429 || status >= 500;

// MCP Events delivery: subscriptions with a signed challenge, then signed content-free webhooks. At least once while the
// process runs; a failed send is retried with the same event id. One subscriber never delays another.
export class Delivery {
  private readonly hosts: Set<string>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly delays: readonly number[];
  private readonly log: (line: string) => void;
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: DeliveryOptions) {
    this.hosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.log = options.log ?? ((line) => console.log(line));
  }

  eventTypes(): readonly EventTypeDescription[] {
    return EVENT_TYPES;
  }

  async subscribe(request: SubscribeRequest): Promise<{ id: string; refreshBefore: string }> {
    if (!EVENT_TYPES.some((type) => type.name === request.name)) throw new DeliveryError('invalid', 'unknown_event', 'No such event type.');
    if (request.mode !== 'webhook') throw new DeliveryError('invalid', 'unsupported_mode', 'Delivery is by webhook only.');
    const callback = URL.canParse(request.url) ? new URL(request.url) : undefined;
    if (!callback || !hostAllowed(callback, this.hosts)) throw new DeliveryError('invalid', 'callback_not_allowed', 'The callback is not on a host the server sends to.');
    const signingKey = signingKeyOf(request.secret);
    if (!signingKey) throw new DeliveryError('invalid', 'bad_secret', 'The signing secret is not a whsec_ secret.');
    const asked = typeof request.ttlMs === 'number' && Number.isFinite(request.ttlMs) ? request.ttlMs : SUBSCRIPTION_TTL_MS;
    const expiresAt = this.now() + Math.min(SUBSCRIPTION_TTL_MS, Math.max(MIN_SUBSCRIPTION_TTL_MS, asked));
    const pending = { clientId: request.clientId, eventName: request.name, callback, signingKey, expiresAt };
    await this.verify(pending, subscriptionId(request.clientId, request.name, callback));
    const id = this.options.store.save(pending);
    this.log(`events subscribed name=${request.name} client=${clientRef(request.clientId)} host=${callback.hostname}`);
    return { id, refreshBefore: new Date(expiresAt).toISOString() };
  }

  unsubscribe(clientId: string, id: string): void {
    this.options.store.remove(id, clientId);
    this.log(`events unsubscribed client=${clientRef(clientId)}`);
  }

  // Sends a content-free event to every active subscription of the type, without waiting for the callbacks.
  publish(name: string, data: Record<string, unknown>): void {
    if (this.stopped) return;
    const work = this.deliverAll(name, data).catch(() => undefined);
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.inFlight]);
  }

  private async verify(pending: Omit<Subscription, 'id'>, id: string): Promise<void> {
    const challenge = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    let reason = 'challenge_failed';
    try {
      const answer = await this.send(pending.callback, pending.signingKey, randomUUID(), body, id);
      let echoed: unknown;
      try { echoed = (JSON.parse(answer.body) as { challenge?: unknown }).challenge; } catch { echoed = undefined; }
      if (accepted(answer.status) && echoed === challenge) return;
    } catch (error) {
      reason = error instanceof CallbackError && error.kind === 'timeout' ? 'timeout' : 'unreachable';
    }
    this.log(`events verification failed client=${clientRef(pending.clientId)} host=${pending.callback.hostname} reason=${reason}`);
    throw new DeliveryError('callback_failed', reason, 'The callback did not pass verification.');
  }

  private send(callback: URL, key: Buffer, messageId: string, body: string, subscriptionId: string) {
    const headers = signedHeaders(key, messageId, this.now(), body, subscriptionId);
    return this.options.transport({ url: callback, headers, body }, AbortSignal.timeout(30_000));
  }

  private async deliverAll(name: string, data: Record<string, unknown>): Promise<void> {
    const subscriptions = this.options.store.active(name, this.now());
    if (subscriptions.length === 0) return;
    const eventId = randomUUID();
    const body = JSON.stringify({ eventId, name, timestamp: new Date(this.now()).toISOString(), data, cursor: null });
    await Promise.allSettled(subscriptions.map((subscription) => this.deliverTo(subscription, eventId, name, body)));
  }

  private async deliverTo(subscription: Subscription, eventId: string, name: string, body: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      let outcome: 'done' | 'gone' | 'retry';
      try {
        const { status } = await this.send(subscription.callback, subscription.signingKey, eventId, body, subscription.id);
        this.log(`events delivery name=${name} client=${clientRef(subscription.clientId)} host=${subscription.callback.hostname} attempt=${attempt} status=${status}`);
        outcome = accepted(status) ? 'done' : status === 410 ? 'gone' : retryable(status) ? 'retry' : 'done';
      } catch (error) {
        const kind = error instanceof CallbackError ? error.kind : 'unreachable';
        this.log(`events delivery name=${name} client=${clientRef(subscription.clientId)} host=${subscription.callback.hostname} attempt=${attempt} error=${kind}`);
        outcome = kind === 'host_not_allowed' || kind === 'address_not_allowed' ? 'done' : 'retry';
      }
      if (outcome === 'gone') this.options.store.forget(subscription.id);
      const delay = this.delays[attempt - 1];
      if (outcome !== 'retry' || delay === undefined || this.stopped) return;
      await this.sleep(delay);
    }
  }
}
