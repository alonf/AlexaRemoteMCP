const events = [
  'session.initialized',
  'session.refreshed',
  'session.reauthentication_required',
  'session.persistence_failed',
  'session.logged_out',
  'probe.started',
  'probe.finished',
] as const;

export type LogEvent = (typeof events)[number];

export function createLogger(write: (line: string) => void) {
  return {
    log(event: LogEvent, details?: unknown): void {
      const safeEvent = (events as readonly string[]).includes(event)
        ? event
        : 'unrecognized_event';
      write(JSON.stringify({
        event: safeEvent,
        ...(details === undefined ? {} : { details: '[REDACTED]' }),
      }));
    },
  };
}
