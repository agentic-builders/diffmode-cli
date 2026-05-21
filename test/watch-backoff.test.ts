import { describe, it, expect } from "vitest";
import {
  computeNextWait,
  isTerminalStatus,
  TERMINAL_STATUSES,
  type WatchBackoffOptions,
} from "../src/lib/watch-backoff";

describe("watch-backoff", () => {
  describe("computeNextWait", () => {
    it("returns server's next_poll_ms when within [3000, 30000] (with stub jitter)", () => {
      const wait = computeNextWait(5000, { random: () => 0.5 });
      // jitter at random=0.5 is 0 (centered), clamp keeps 5000
      expect(wait).toBe(5000);
    });

    it("clamps below the 3000 ms floor", () => {
      const wait = computeNextWait(1000, { random: () => 0.5 });
      expect(wait).toBe(3000);
    });

    it("clamps above the 30000 ms ceiling", () => {
      const wait = computeNextWait(60000, { random: () => 0.5 });
      expect(wait).toBe(30000);
    });

    it("applies +20% jitter when random() = 1 (max)", () => {
      // jitter = 5000 * (1 + (1-0.5)*0.4) = 5000 * 1.2 = 6000
      const wait = computeNextWait(5000, { random: () => 1 });
      expect(wait).toBe(6000);
    });

    it("applies -20% jitter when random() = 0 (min)", () => {
      // jitter = 5000 * (1 + (0-0.5)*0.4) = 5000 * 0.8 = 4000
      const wait = computeNextWait(5000, { random: () => 0 });
      expect(wait).toBe(4000);
    });

    it("defaults to 5000 ms when next_poll_ms is missing/null/undefined", () => {
      expect(computeNextWait(undefined, { random: () => 0.5 })).toBe(5000);
      expect(computeNextWait(null, { random: () => 0.5 })).toBe(5000);
    });

    it("applies jitter THEN clamp (order matters)", () => {
      // 2900 + 20% jitter = 3480, clamp lets 3480 through
      const wait = computeNextWait(2900, { random: () => 1 });
      expect(wait).toBe(3480);
    });

    it("clamp catches values pushed below floor by jitter", () => {
      // 3100 with -20% jitter -> 2480, clamped to 3000
      const wait = computeNextWait(3100, { random: () => 0 });
      expect(wait).toBe(3000);
    });
  });

  describe("isTerminalStatus", () => {
    it("returns true for completed/failed/interrupted/cancelled", () => {
      expect(isTerminalStatus("completed")).toBe(true);
      expect(isTerminalStatus("failed")).toBe(true);
      expect(isTerminalStatus("interrupted")).toBe(true);
      expect(isTerminalStatus("cancelled")).toBe(true);
    });

    it("returns false for active statuses", () => {
      expect(isTerminalStatus("pending")).toBe(false);
      expect(isTerminalStatus("running")).toBe(false);
    });

    it("returns false for unknown status strings", () => {
      expect(isTerminalStatus("strange-status")).toBe(false);
      expect(isTerminalStatus("")).toBe(false);
    });
  });

  describe("TERMINAL_STATUSES set", () => {
    it("exactly mirrors models.py:38-39 frozenset", () => {
      expect([...TERMINAL_STATUSES].sort()).toEqual(
        ["cancelled", "completed", "failed", "interrupted"].sort(),
      );
    });
  });

  describe("WatchBackoffOptions type", () => {
    it("permits a custom random source", () => {
      const opts: WatchBackoffOptions = { random: () => 0.42 };
      expect(opts.random?.()).toBe(0.42);
    });
  });
});
