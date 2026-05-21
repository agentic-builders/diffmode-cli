// Watch-backoff: server-driven `next_poll_ms` + ±20% jitter + clamp to [3000, 30000] ms.
// Order: server hint → jitter → clamp.

export const MIN_WAIT_MS = 3000;
export const MAX_WAIT_MS = 30_000;
export const DEFAULT_WAIT_MS = 5000;
export const JITTER_RATIO = 0.2;

export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

export const ACTIVE_STATUSES = new Set(["pending", "running"]);

export interface WatchBackoffOptions {
  random?: () => number;
}

export function computeNextWait(
  nextPollMs: number | null | undefined,
  opts: WatchBackoffOptions = {},
): number {
  const rng = opts.random ?? Math.random;
  const hint =
    typeof nextPollMs === "number" && Number.isFinite(nextPollMs) && nextPollMs > 0
      ? nextPollMs
      : DEFAULT_WAIT_MS;
  // ±20% jitter: rng() ∈ [0, 1) → multiplier ∈ [0.8, 1.2)
  const multiplier = 1 + (rng() - 0.5) * JITTER_RATIO * 2;
  const jittered = hint * multiplier;
  return Math.round(clamp(jittered, MIN_WAIT_MS, MAX_WAIT_MS));
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
