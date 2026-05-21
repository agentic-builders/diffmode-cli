import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  printJson,
  printNdjson,
  printError,
  shouldEmitJson,
  printProgress,
  setOutputConfig,
  resetOutputConfig,
} from "../src/lib/output";
import { DiffmodeError, AuthError, ConflictError } from "../src/lib/errors";

type Captured = { stdout: string; stderr: string; exitCode?: number };

function captureStreams(): Captured {
  const captured: Captured = { stdout: "", stderr: "" };
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as any);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as any);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exitCode = code ?? 0;
    return undefined as never;
  }) as any);
  return captured;
}

describe("printJson", () => {
  beforeEach(() => {
    resetOutputConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetOutputConfig();
  });

  it("writes schema_version:1 + payload to stdout with trailing newline", () => {
    const cap = captureStreams();
    printJson({ job_id: "j1", status: "queued" });
    expect(cap.stdout.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed).toEqual({
      schema_version: "1",
      job_id: "j1",
      status: "queued",
    });
  });

  it("CLI schema_version always wins — server-supplied value is overwritten", () => {
    // Regression: server responses (e.g. `jobs status`, `jobs watch`) are passed
    // straight through `printJson(resp.data)`. If the backend ever grows its own
    // `schema_version` field, the CLI must NOT silently echo it — agents pin to
    // the CLI's "1".
    const cap = captureStreams();
    printJson({ schema_version: "2", job_id: "j1", status: "queued" });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.job_id).toBe("j1");
    expect(parsed.status).toBe("queued");
  });
});

describe("printNdjson", () => {
  beforeEach(() => {
    resetOutputConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetOutputConfig();
  });

  it("writes one JSON object per line", () => {
    const cap = captureStreams();
    printNdjson([
      { job_id: "a", status: "queued" },
      { job_id: "b", status: "running" },
    ]);
    const lines = cap.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ job_id: "a", status: "queued" });
    expect(JSON.parse(lines[1]!)).toEqual({ job_id: "b", status: "running" });
  });

  it("emits nothing for empty array", () => {
    const cap = captureStreams();
    printNdjson([]);
    expect(cap.stdout).toBe("");
  });
});

describe("printError", () => {
  beforeEach(() => {
    resetOutputConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetOutputConfig();
  });

  it("writes structured error with schema_version to stderr + exits with code", () => {
    const cap = captureStreams();
    const err = new AuthError("No valid token");
    printError(err);
    const parsed = JSON.parse(cap.stderr);
    // Error envelope MUST carry schema_version (matches stdout envelope shape,
    // so agents can version-gate both streams the same way).
    expect(parsed.schema_version).toBe("1");
    expect(parsed.error.code).toBe("auth");
    expect(parsed.error.message).toBe("No valid token");
    expect(parsed.error.retryable).toBe(false);
    expect(cap.exitCode).toBe(4);
  });

  it("non-Diffmode generic error envelope also carries schema_version", () => {
    const cap = captureStreams();
    printError(new Error("kaboom-x"));
    const parsed = JSON.parse(cap.stderr);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.error.code).toBe("generic");
  });

  it("includes retry_after when present (ConflictError carries job_id, not retry_after; use generic for retry_after test)", () => {
    const cap = captureStreams();
    const err = new DiffmodeError({
      code: "rate_limited",
      message: "Slow down",
      retryable: true,
      retry_after: 30,
      exitCode: 7,
    });
    printError(err);
    const parsed = JSON.parse(cap.stderr);
    expect(parsed.error.retry_after).toBe(30);
    expect(parsed.error.retryable).toBe(true);
    expect(cap.exitCode).toBe(7);
  });

  it("includes docs_url when present", () => {
    const cap = captureStreams();
    const err = new DiffmodeError({
      code: "usage",
      message: "Bad flag",
      retryable: false,
      docs_url: "https://example/docs",
      exitCode: 2,
    });
    printError(err);
    const parsed = JSON.parse(cap.stderr);
    expect(parsed.error.docs_url).toBe("https://example/docs");
  });

  it("ConflictError carries job_id under error.job_id", () => {
    const cap = captureStreams();
    const err = new ConflictError("job already running", "job-123", "p");
    printError(err);
    const parsed = JSON.parse(cap.stderr);
    expect(parsed.error.code).toBe("conflict");
    expect(parsed.error.job_id).toBe("job-123");
    expect(cap.exitCode).toBe(5);
  });

  it("non-DiffmodeError falls back to generic exit 1", () => {
    const cap = captureStreams();
    printError(new Error("kaboom"));
    const parsed = JSON.parse(cap.stderr);
    expect(parsed.error.code).toBe("generic");
    expect(parsed.error.message).toContain("kaboom");
    expect(cap.exitCode).toBe(1);
  });
});

describe("shouldEmitJson + TTY detection", () => {
  beforeEach(() => {
    resetOutputConfig();
  });
  afterEach(() => {
    resetOutputConfig();
  });

  it("--json forces JSON even when isTTY=true", () => {
    setOutputConfig({ json: true, isTTY: true });
    expect(shouldEmitJson()).toBe(true);
  });

  it("non-TTY without --json still emits JSON", () => {
    setOutputConfig({ json: false, isTTY: false });
    expect(shouldEmitJson()).toBe(true);
  });

  it("TTY without --json emits human-readable (false)", () => {
    setOutputConfig({ json: false, isTTY: true });
    expect(shouldEmitJson()).toBe(false);
  });
});

describe("printProgress (quiet / verbose)", () => {
  beforeEach(() => {
    resetOutputConfig();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetOutputConfig();
  });

  it("emits to stderr by default", () => {
    const cap = captureStreams();
    printProgress("running");
    expect(cap.stderr).toContain("running");
    expect(cap.stdout).toBe("");
  });

  it("--quiet suppresses progress on stderr", () => {
    const cap = captureStreams();
    setOutputConfig({ quiet: true });
    printProgress("running");
    expect(cap.stderr).toBe("");
  });

  it("--verbose does not suppress (default behavior continues)", () => {
    const cap = captureStreams();
    setOutputConfig({ verbose: true });
    printProgress("running");
    expect(cap.stderr).toContain("running");
  });
});
