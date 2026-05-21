import { describe, it, expect } from "vitest";
import {
  DiffmodeError,
  UsageError,
  NetworkError,
  AuthError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  InsufficientCreditsError,
  ServerError,
  InterruptedResumableError,
} from "../src/lib/errors";
import { ExitCode } from "../src/lib/exit-codes";

describe("DiffmodeError", () => {
  it("carries code, message, retryable, exitCode + optional retry_after/docs_url", () => {
    const err = new DiffmodeError({
      code: "rate_limited",
      message: "calm down",
      retryable: true,
      retry_after: 30,
      docs_url: "https://example/docs",
      exitCode: ExitCode.RATE_LIMITED,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toBe("calm down");
    expect(err.retryable).toBe(true);
    expect(err.retry_after).toBe(30);
    expect(err.docs_url).toBe("https://example/docs");
    expect(err.exitCode).toBe(7);
  });

  it("serializes to {code, message, retryable, ...}", () => {
    const err = new DiffmodeError({
      code: "auth",
      message: "no token",
      retryable: false,
      exitCode: ExitCode.AUTH,
    });
    expect(err.toJSON()).toEqual({
      code: "auth",
      message: "no token",
      retryable: false,
    });
  });

  it("toJSON includes retry_after/docs_url/job_id when set", () => {
    const err = new DiffmodeError({
      code: "conflict",
      message: "job running",
      retryable: false,
      job_id: "j-1",
      product_id: "p-1",
      exitCode: ExitCode.CONFLICT,
    });
    expect(err.toJSON()).toEqual({
      code: "conflict",
      message: "job running",
      retryable: false,
      job_id: "j-1",
      product_id: "p-1",
    });
  });
});

describe("Subclasses default to spec exit codes", () => {
  it("UsageError → exit 2", () => {
    const e = new UsageError("bad flag");
    expect(e.exitCode).toBe(ExitCode.USAGE);
    expect(e.code).toBe("usage");
    expect(e.retryable).toBe(false);
  });

  it("NetworkError → exit 3", () => {
    const e = new NetworkError("DNS failed");
    expect(e.exitCode).toBe(ExitCode.NETWORK);
    expect(e.code).toBe("network");
    expect(e.retryable).toBe(true);
  });

  it("AuthError → exit 4", () => {
    const e = new AuthError("revoked");
    expect(e.exitCode).toBe(ExitCode.AUTH);
    expect(e.code).toBe("auth");
    expect(e.retryable).toBe(false);
  });

  it("ConflictError → exit 5 + carries job_id", () => {
    const e = new ConflictError("job already running", "j-9", "p-1");
    expect(e.exitCode).toBe(ExitCode.CONFLICT);
    expect(e.code).toBe("conflict");
    expect(e.job_id).toBe("j-9");
    expect(e.product_id).toBe("p-1");
    expect(e.retryable).toBe(false);
  });

  it("NotFoundError → exit 6", () => {
    const e = new NotFoundError("job not found");
    expect(e.exitCode).toBe(ExitCode.NOT_FOUND);
    expect(e.code).toBe("not_found");
  });

  it("RateLimitedError → exit 7 + retry_after", () => {
    const e = new RateLimitedError("slow", 60);
    expect(e.exitCode).toBe(ExitCode.RATE_LIMITED);
    expect(e.code).toBe("rate_limited");
    expect(e.retry_after).toBe(60);
    expect(e.retryable).toBe(true);
  });

  it("InsufficientCreditsError → exit 8 + billingUrl from resolveBillingUrl", () => {
    const e = new InsufficientCreditsError(
      "need 15",
      "https://diffmode.app/app/billing",
    );
    expect(e.exitCode).toBe(ExitCode.INSUFFICIENT_CREDITS);
    expect(e.code).toBe("insufficient_credits");
    expect(e.billing_url).toBe("https://diffmode.app/app/billing");
    expect(e.retryable).toBe(false);
  });

  it("ServerError → exit 9", () => {
    const e = new ServerError("backend 500", true);
    expect(e.exitCode).toBe(ExitCode.SERVER);
    expect(e.code).toBe("server");
    expect(e.retryable).toBe(true);
  });

  it("InterruptedResumableError → exit 10 with resume hint", () => {
    const e = new InterruptedResumableError("job interrupted", "j-1");
    expect(e.exitCode).toBe(ExitCode.INTERRUPTED_RESUMABLE);
    expect(e.code).toBe("interrupted");
    expect(e.job_id).toBe("j-1");
    expect(e.retryable).toBe(true);
  });
});
