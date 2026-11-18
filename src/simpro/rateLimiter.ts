/**
 * Token-bucket rate limiter. Simpro allows ~10 requests/second per
 * integration, shared by everyone using it, so one limiter is shared by the
 * whole process (all users in hosted mode draw from the same bucket).
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly perSecond: number,
    private readonly burst = perSecond,
  ) {
    this.tokens = burst;
  }

  /** Resolves when a request may be sent. Calls are served in order. */
  take(): Promise<void> {
    const next = this.queue.then(() => this.waitForToken());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async waitForToken(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.perSecond) * 1000;
      await new Promise((r) => setTimeout(r, Math.ceil(waitMs)));
    }
  }
}

let shared: RateLimiter | undefined;

export function sharedLimiter(perSecond = 8): RateLimiter {
  shared ??= new RateLimiter(perSecond);
  return shared;
}
