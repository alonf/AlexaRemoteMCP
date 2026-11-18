// The bounded fetch for MCP Events callbacks. Only allowed HTTPS hosts, only public addresses (checked as the connection
// is made, so a resolver answer cannot turn a callback inward), no redirects, a time limit and a size limit on the answer.
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress } from 'node:dns';
import { Agent, request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

export interface CallbackRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

export interface CallbackResponse {
  status: number;
  body: string;
}

export type CallbackTransport = (request: CallbackRequest, signal: AbortSignal) => Promise<CallbackResponse>;

export type CallbackErrorKind = 'host_not_allowed' | 'address_not_allowed' | 'timeout' | 'unreachable';

// The message never quotes the callback's address.
export class CallbackError extends Error {
  constructor(readonly kind: CallbackErrorKind, options?: ErrorOptions) {
    super(`The callback could not be reached: ${kind}.`, options);
    this.name = 'CallbackError';
  }
}

export interface CallbackTransportOptions {
  allowedHosts: readonly string[];
  timeoutMs: number;
  maxResponseBytes: number;
  addressAllowed?: (address: string) => boolean;
  trustedCertificates?: string;
  lookup?: LookupFunction;
}

const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');
}
const MAPPED_IPV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function isPublicAddress(address: string): boolean {
  const mapped = MAPPED_IPV4.exec(address)?.[1];
  if (mapped !== undefined) return isPublicAddress(mapped);
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function checkedLookup(resolve: LookupFunction, allowed: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, options, (error, address, family) => {
      if (error !== null) return callback(error, address, family);
      const addresses: readonly LookupAddress[] = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
      if (addresses.length === 0 || !addresses.every((entry) => allowed(entry.address))) {
        return callback(new CallbackError('address_not_allowed'), '', 4);
      }
      callback(null, address, family);
    });
  };
}

export function hostAllowed(url: URL, hosts: ReadonlySet<string>): boolean {
  return url.protocol === 'https:' && url.username === '' && url.password === '' && hosts.has(url.host.toLowerCase());
}

export function httpsCallbackTransport(options: CallbackTransportOptions): CallbackTransport {
  const hosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const lookup = checkedLookup(options.lookup ?? (dnsLookup as LookupFunction), options.addressAllowed ?? isPublicAddress);
  // Its own pool: a reused connection was made through this checked resolver, never Node's shared agent.
  const agent = new Agent({ keepAlive: true, lookup, ...(options.trustedCertificates === undefined ? {} : { ca: options.trustedCertificates }) });
  return (request, signal) => {
    if (!hostAllowed(request.url, hosts)) return Promise.reject(new CallbackError('host_not_allowed'));
    return exchange(request, signal, options, agent);
  };
}

function exchange(request: CallbackRequest, signal: AbortSignal, options: CallbackTransportOptions, agent: Agent): Promise<CallbackResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => outgoing.destroy(new CallbackError('timeout')), options.timeoutMs);
    const outgoing = httpsRequest(
      request.url,
      { method: 'POST', headers: { ...request.headers, 'content-length': String(Buffer.byteLength(request.body)) }, agent, signal },
      (incoming) => {
        const chunks: Buffer[] = [];
        let read = 0;
        incoming.on('data', (chunk: Buffer) => {
          const room = options.maxResponseBytes - read;
          if (room > 0) {
            chunks.push(chunk.subarray(0, room));
            read += Math.min(room, chunk.length);
          }
        });
        incoming.on('end', () => {
          clearTimeout(timer);
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
        incoming.on('error', (error) => {
          clearTimeout(timer);
          reject(asCallbackError(error));
        });
      },
    );
    outgoing.on('error', (error) => {
      clearTimeout(timer);
      reject(asCallbackError(error));
    });
    outgoing.end(request.body);
  });
}

function asCallbackError(error: unknown): CallbackError {
  if (error instanceof CallbackError) return error;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof CallbackError) return cause;
  return new CallbackError('unreachable', { cause: error });
}
