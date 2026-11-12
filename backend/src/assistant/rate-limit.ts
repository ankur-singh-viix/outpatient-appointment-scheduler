/**
 * A sliding-window limit per key (the signed-in user), kept in memory: it protects the model bill and the provider's quota from one
 * user (or a runaway script) without any extra infrastructure. With more than one server each keeps its own count, so the effective
 * limit is per server; that is fine for cost protection, which is all this is for.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records one use and says whether it is allowed; when it is not, how long until it would be. Nothing is recorded for a refusal. */
  take(key: string, now = Date.now()): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(now);
    return { allowed: true };
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) if (times.every((at) => now - at >= this.windowMs)) this.hits.delete(key);
  }
}
