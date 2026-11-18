import type { Outcome } from './outcomes.js';

export interface OrderingContext {
  // True while no newer operation has claimed any of this operation's targets.
  isCurrent(): boolean;
  // Runs one dispatch, retry or verification step only if the operation is still the newest.
  step(run: () => Promise<Outcome>): Promise<Outcome>;
}

const SUPERSEDED: Outcome = { status: 'superseded' };

// Serializes operations per target and lets the newest intent win. The claim is taken
// synchronously when run() is called, so arrival order defines the final intent even if
// an older operation is still queued or between its dispatch and verification steps.
export class TargetOrdering {
  private readonly latest = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private counter = 0;

  async run(targets: readonly string[], work: (context: OrderingContext) => Promise<Outcome>): Promise<Outcome> {
    const unique = [...new Set(targets)];
    const claim = ++this.counter;
    for (const target of unique) this.latest.set(target, claim);

    const previous = unique.map((target) => this.tails.get(target) ?? Promise.resolve());
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const tail = Promise.all(previous).then(() => done);
    for (const target of unique) this.tails.set(target, tail);

    const isCurrent = () => unique.every((target) => this.latest.get(target) === claim);
    const context: OrderingContext = {
      isCurrent,
      step: async (run) => (isCurrent() ? run() : SUPERSEDED),
    };
    try {
      await Promise.all(previous);
      if (!isCurrent()) return SUPERSEDED;
      return await work(context);
    } finally {
      release();
      for (const target of unique) {
        if (this.tails.get(target) === tail) this.tails.delete(target);
        if (this.latest.get(target) === claim) this.latest.delete(target);
      }
    }
  }
}
