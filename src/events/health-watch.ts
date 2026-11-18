import type { SessionHealth } from '../session-manager.js';

// Calls `announce` once per transition into a state the owner must act on, never for a repeat of the same state.
export function healthWatcher(initial: SessionHealth, announce: (health: SessionHealth) => void): (current: SessionHealth) => void {
  let last = initial;
  return (current) => {
    if (current === last) return;
    last = current;
    if (current === 'reauthentication_required' || current === 'temporarily_unavailable') announce(current);
  };
}
