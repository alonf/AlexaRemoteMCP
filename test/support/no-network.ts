import net from 'node:net';

const loopback = new Set(['127.0.0.1', '::1', 'localhost']);

function targetHost(args: unknown[]): string | undefined | null {
  // net.connect passes normalized arguments as one array: [options, callback].
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === 'string') return undefined;
    return typeof options.host === 'string' ? options.host : 'localhost';
  }
  if (typeof first === 'string') return null;
  return typeof args[1] === 'string' ? args[1] : 'localhost';
}

// Importing this module makes any non-loopback socket connection throw, so tests cannot reach Amazon.
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(this: net.Socket, ...args: unknown[]) {
  const host = targetHost(args);
  if (host === undefined) return Reflect.apply(original, this, args);
  if (host === null || !loopback.has(host)) throw new Error('Network access blocked in tests');
  return Reflect.apply(original, this, args);
} as typeof net.Socket.prototype.connect;
