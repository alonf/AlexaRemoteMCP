// Shares one device-inventory read between all callers. A cached copy is served until maxAgeMs; a background
// refresh keeps it warm so callers rarely wait for Amazon. Failures are never cached and keep the old copy.
export function cachedInventory(
  fetchInventory: () => Promise<unknown>,
  maxAgeMs: number,
  now: () => number = Date.now,
): { read: () => Promise<unknown>; refresh: () => Promise<void> } {
  let entry: { at: number; body: unknown } | undefined;
  let inflight: Promise<unknown> | undefined;

  const load = (): Promise<unknown> => {
    inflight ??= fetchInventory()
      .then((body) => {
        entry = { at: now(), body };
        return body;
      })
      .finally(() => { inflight = undefined; });
    return inflight;
  };

  return {
    read: () => (entry && now() - entry.at < maxAgeMs ? Promise.resolve(entry.body) : load()),
    refresh: () => load().then(() => undefined, () => undefined),
  };
}
