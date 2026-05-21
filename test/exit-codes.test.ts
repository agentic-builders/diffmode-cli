import { describe, it, expect } from "vitest";
import { ExitCode } from "../src/lib/exit-codes";

describe("ExitCode constants (spec §8)", () => {
  it("matches the published table verbatim", () => {
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.GENERIC).toBe(1);
    expect(ExitCode.USAGE).toBe(2);
    expect(ExitCode.NETWORK).toBe(3);
    expect(ExitCode.AUTH).toBe(4);
    expect(ExitCode.CONFLICT).toBe(5);
    expect(ExitCode.NOT_FOUND).toBe(6);
    expect(ExitCode.RATE_LIMITED).toBe(7);
    expect(ExitCode.INSUFFICIENT_CREDITS).toBe(8);
    expect(ExitCode.SERVER).toBe(9);
    expect(ExitCode.INTERRUPTED_RESUMABLE).toBe(10);
    expect(ExitCode.SIGINT).toBe(130);
  });
});
