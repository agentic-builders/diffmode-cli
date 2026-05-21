import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { resetOutputConfig, setOutputConfig } from "../src/lib/output";
import { jobsListCommand } from "../src/commands/jobs/list";
import { jobsStatusCommand } from "../src/commands/jobs/status";
import { jobsWatchCommand } from "../src/commands/jobs/watch";
import { jobsResumeCommand } from "../src/commands/jobs/resume";
import { jobsCancelCommand } from "../src/commands/jobs/cancel";

const API_BASE = "https://api.test/public/v1";
const TOKEN = "dm_pat_jobs_token_xxxxxxxxxxxxxxxx";

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
    throw new Error(`__exit__:${code ?? 0}`);
  }) as any);
  return captured;
}

const server = setupServer();

beforeEach(() => {
  server.listen({ onUnhandledRequest: "error" });
  resetOutputConfig();
  setOutputConfig({ json: true });
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  vi.restoreAllMocks();
  resetOutputConfig();
});

describe("diffmode jobs list", () => {
  it("emits NDJSON when --json or non-TTY", async () => {
    server.use(
      http.get(`${API_BASE}/jobs`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("limit")).toBe("10");
        return HttpResponse.json({
          jobs: [
            { job_id: "j1", status: "completed", product_id: "acme", module_type: "free-tier" },
            { job_id: "j2", status: "running", product_id: "acme", module_type: "workflow" },
          ],
          total: 2,
          next_cursor: "c123",
        });
      }),
    );
    const cap = captureStreams();
    await jobsListCommand({
      apiBase: API_BASE,
      token: TOKEN,
      limit: 10,
    });
    const lines = cap.stdout.trim().split("\n");
    expect(lines).toHaveLength(3); // 2 jobs + 1 cursor record
    expect(JSON.parse(lines[0]!).job_id).toBe("j1");
    expect(JSON.parse(lines[1]!).job_id).toBe("j2");
    expect(JSON.parse(lines[2]!).cursor).toBe("c123");
  });

  it("passes product/status/cursor query params correctly", async () => {
    let observedUrl = "";
    server.use(
      http.get(`${API_BASE}/jobs`, ({ request }) => {
        observedUrl = request.url;
        return HttpResponse.json({
          jobs: [],
          total: 0,
          next_cursor: null,
        });
      }),
    );
    captureStreams();
    await jobsListCommand({
      apiBase: API_BASE,
      token: TOKEN,
      product: "acme",
      status: "running",
      limit: 50,
      cursor: "prev-c",
    });
    const url = new URL(observedUrl);
    expect(url.searchParams.get("product_id")).toBe("acme");
    expect(url.searchParams.get("status")).toBe("running");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("cursor")).toBe("prev-c");
  });
});

describe("diffmode jobs status", () => {
  it("fetches /jobs/{id} and pretty-prints the response on JSON", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-abc`, () =>
        HttpResponse.json({
          job_id: "job-abc",
          status: "running",
          module_type: "free-tier",
          product_id: "acme",
          next_poll_ms: 5000,
          progress: {
            current_stage: "diagnostics",
            stages_completed: 2,
            total_stages: 10,
          },
        }),
      ),
    );
    const cap = captureStreams();
    await jobsStatusCommand({
      jobId: "job-abc",
      apiBase: API_BASE,
      token: TOKEN,
    });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.job_id).toBe("job-abc");
    expect(parsed.status).toBe("running");
    expect(parsed.progress.current_stage).toBe("diagnostics");
  });

  it("exits 6 on 404", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/missing`, () =>
        HttpResponse.json({ detail: "Job not found" }, { status: 404 }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsStatusCommand({
        jobId: "missing",
        apiBase: API_BASE,
        token: TOKEN,
      }),
    ).rejects.toThrow(/__exit__:6/);
    expect(cap.exitCode).toBe(6);
  });
});

describe("diffmode jobs watch", () => {
  it("polls until terminal `completed`, exit 0", async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/jobs/job-w`, () => {
        calls += 1;
        if (calls < 2) {
          return HttpResponse.json({
            job_id: "job-w",
            status: "running",
            module_type: "free-tier",
            next_poll_ms: 1, // small so test runs fast
            progress: {
              current_stage: "stage-a",
              stages_completed: 1,
              total_stages: 3,
            },
          });
        }
        return HttpResponse.json({
          job_id: "job-w",
          status: "completed",
          module_type: "free-tier",
        });
      }),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-w",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:0/);
    expect(cap.exitCode).toBe(0);
    expect(calls).toBe(2);
    const lastLine = cap.stdout.trim().split("\n").pop()!;
    const parsed = JSON.parse(lastLine);
    expect(parsed.status).toBe("completed");
  });

  it("on `failed` terminal status, exit 1 + error text", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-f`, () =>
        HttpResponse.json({
          job_id: "job-f",
          status: "failed",
          module_type: "workflow",
          error: "Stage `cro` raised: ValueError",
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-f",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:1/);
    expect(cap.exitCode).toBe(1);
  });

  it("on `interrupted` for resumable module, exit 10 with hint", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-i`, () =>
        HttpResponse.json({
          job_id: "job-i",
          status: "interrupted",
          module_type: "free-tier",
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-i",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:10/);
    expect(cap.exitCode).toBe(10);
    expect(cap.stderr).toMatch(/resume/i);
    // Codex regression: in non-TTY mode every stderr line must be valid
    // NDJSON. The interrupted-resumable hint formerly used printProgress()
    // plain text, which broke any agent parsing stderr line-by-line.
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    for (const line of stderrLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const hintRecord = stderrLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r["event"] === "interrupted_resumable");
    expect(hintRecord).toBeDefined();
    expect(hintRecord!["job_id"]).toBe("job-i");
    expect(String(hintRecord!["hint"])).toMatch(/resume/i);
  });

  it("on `interrupted` for non-resumable module, exit 10 with resubmit hint", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-i2`, () =>
        HttpResponse.json({
          job_id: "job-i2",
          status: "interrupted",
          module_type: "idea-eval",
          product_id: "acme",
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-i2",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:10/);
    expect(cap.exitCode).toBe(10);
    expect(cap.stderr).toMatch(/not resumable|resubmit/i);
    // Codex regression: stderr NDJSON contract — the resubmit hint must be a
    // parsable JSON record, not free-form `printProgress()` text.
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    for (const line of stderrLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const hintRecord = stderrLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r["event"] === "interrupted_not_resumable");
    expect(hintRecord).toBeDefined();
    expect(hintRecord!["job_id"]).toBe("job-i2");
    expect(String(hintRecord!["hint"])).toMatch(/not resumable|resubmit/i);
  });

  it("non-TTY mode: progress events are NDJSON on stderr, terminal on stdout, no ANSI codes", async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/jobs/job-nt`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({
            job_id: "job-nt",
            status: "running",
            module_type: "free-tier",
            next_poll_ms: 1,
            progress: {
              current_stage: "init",
              stages_completed: 0,
              total_stages: 3,
            },
          });
        }
        return HttpResponse.json({
          job_id: "job-nt",
          status: "completed",
          module_type: "free-tier",
        });
      }),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-nt",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:0/);
    expect(cap.exitCode).toBe(0);
    // Stderr should have NDJSON progress lines
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    for (const line of stderrLines) {
      // Each line should parse as JSON
      const parsed = JSON.parse(line);
      expect(parsed).toBeTypeOf("object");
    }
    // No ANSI escape codes anywhere
    expect(cap.stdout).not.toMatch(/\[/);
    expect(cap.stderr).not.toMatch(/\[/);
  });

  it("--quiet suppresses NDJSON progress on non-TTY (terminal payload still emitted)", async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/jobs/job-q`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({
            job_id: "job-q",
            status: "running",
            module_type: "free-tier",
            next_poll_ms: 1,
            progress: {
              current_stage: "init",
              stages_completed: 0,
              total_stages: 3,
            },
          });
        }
        return HttpResponse.json({
          job_id: "job-q",
          status: "completed",
          module_type: "free-tier",
        });
      }),
    );
    setOutputConfig({ quiet: true });
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-q",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:0/);
    expect(cap.exitCode).toBe(0);
    // Progress NDJSON on stderr must be suppressed under --quiet.
    expect(cap.stderr).toBe("");
    // Terminal payload still emitted on stdout.
    const lastLine = cap.stdout.trim().split("\n").pop()!;
    expect(JSON.parse(lastLine).status).toBe("completed");
  });

  it("on `failed` terminal status WITHOUT server `error` string, emits envelope + exits 1", async () => {
    // Backend may report status=failed without populating `error`. Without
    // an explicit handler the watch loop used to fall through to exit 1
    // with no stderr envelope at all — agents had nothing structured to
    // surface. Verify the fallback message + envelope.
    server.use(
      http.get(`${API_BASE}/jobs/job-fne`, () =>
        HttpResponse.json({
          job_id: "job-fne",
          status: "failed",
          module_type: "workflow",
          // intentionally no `error` field
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-fne",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:1/);
    expect(cap.exitCode).toBe(1);
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    const envelopeLine = stderrLines.find((l) => l.includes('"error"'));
    expect(envelopeLine).toBeDefined();
    const env = JSON.parse(envelopeLine!);
    expect(env.schema_version).toBe("1");
    expect(env.error.code).toBe("generic");
    expect(env.error.message).toMatch(/failed without a server-provided reason/);
    expect(env.error.job_id).toBe("job-fne");
  });

  it("on `cancelled` terminal status, emits envelope + exits 1", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-cnc`, () =>
        HttpResponse.json({
          job_id: "job-cnc",
          status: "cancelled",
          module_type: "free-tier",
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-cnc",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:1/);
    expect(cap.exitCode).toBe(1);
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    const envelopeLine = stderrLines.find((l) => l.includes('"error"'));
    expect(envelopeLine).toBeDefined();
    const env = JSON.parse(envelopeLine!);
    expect(env.error.message).toMatch(/cancelled/i);
    expect(env.error.job_id).toBe("job-cnc");
  });

  it("survives a transient 503 mid-poll (retries, then succeeds)", async () => {
    // A long-running watch must not die on a single transient blip. After
    // a retryable failure the loop should back off and try again.
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/jobs/job-tr`, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { detail: "upstream timeout", error: { retryable: true } },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          job_id: "job-tr",
          status: "completed",
          module_type: "free-tier",
        });
      }),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-tr",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:0/);
    expect(cap.exitCode).toBe(0);
    expect(calls).toBe(2);
    // Codex regression: in non-TTY mode every stderr line must be valid
    // NDJSON. The retry notice formerly used printProgress() plain text,
    // which broke any agent parsing stderr line-by-line.
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    for (const line of stderrLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const retryLine = stderrLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r["event"] === "transient_error");
    expect(retryLine).toBeDefined();
    expect(retryLine!["job_id"]).toBe("job-tr");
    expect(retryLine!["attempt"]).toBe(1);
    expect(retryLine!["max_attempts"]).toBe(5);
  });

  it("gives up after 5 consecutive transient failures with exit 3", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-tr-loop`, () =>
        HttpResponse.json(
          { detail: "still down", error: { retryable: true } },
          { status: 503 },
        ),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-tr-loop",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:3/);
    expect(cap.exitCode).toBe(3);
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    const envelopeLine = stderrLines.find((l) => l.includes('"error"'));
    expect(envelopeLine).toBeDefined();
    const env = JSON.parse(envelopeLine!);
    expect(env.error.code).toBe("network");
    expect(env.error.message).toMatch(/5 consecutive transient errors/);
  });

  it("persistent 429s surface as code rate_limited with Retry-After + exit 7", async () => {
    server.use(
      http.get(
        `${API_BASE}/jobs/job-429-loop`,
        () =>
          new HttpResponse(JSON.stringify({ detail: "slow down" }), {
            status: 429,
            headers: { "Retry-After": "12", "Content-Type": "application/json" },
          }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-429-loop",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:7/);
    expect(cap.exitCode).toBe(7);
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    const envelopeLine = stderrLines.find((l) => l.includes('"error"'));
    expect(envelopeLine).toBeDefined();
    const env = JSON.parse(envelopeLine!);
    expect(env.error.code).toBe("rate_limited");
    expect(env.error.retry_after).toBe(12);
    expect(env.error.message).toMatch(/consecutive rate-limit/i);
    // Each retry notice on stderr must be NDJSON in non-TTY mode (matches
    // the progress NDJSON contract so agents parse stderr line-by-line).
    for (const line of stderrLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const retryRecords = stderrLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r["event"] === "rate_limited");
    expect(retryRecords.length).toBeGreaterThan(0);
    expect(retryRecords[0]!["retry_after"]).toBe(12);
  });

  it("4 transient errors followed by a single 429 surfaces as code network (exit 3), not rate_limited", async () => {
    // Regression: a streak of transient errors ending in one 429 must not
    // be misclassified as persistent rate limiting. Exit 7 is reserved for
    // ≥5 *consecutive* 429s; mixed streaks are network instability.
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/jobs/job-mix`, () => {
        calls += 1;
        if (calls <= 4) {
          return HttpResponse.json(
            { detail: "upstream", error: { retryable: true } },
            { status: 503 },
          );
        }
        if (calls === 5) {
          return new HttpResponse(JSON.stringify({ detail: "slow down" }), {
            status: 429,
            headers: { "Retry-After": "8", "Content-Type": "application/json" },
          });
        }
        // After the 429 resets the transient streak, keep returning 503 to
        // exhaust the transient counter again so the loop terminates.
        return HttpResponse.json(
          { detail: "still down", error: { retryable: true } },
          { status: 503 },
        );
      }),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-mix",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:3/);
    expect(cap.exitCode).toBe(3);
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    const envelopeLine = stderrLines.find((l) => l.includes('"error"'));
    expect(envelopeLine).toBeDefined();
    const env = JSON.parse(envelopeLine!);
    expect(env.error.code).toBe("network");
  });

  it("--wait deadline fires even while sleeping inside a retry branch (429 Retry-After)", async () => {
    // A single 429 with a long Retry-After must NOT push the watch past the
    // user's documented --wait cap. The deadline is checked at the top of
    // every loop iteration AND the retry sleep is clamped to remaining
    // budget, so the next iteration immediately exits 1 (generic timeout).
    let now = 1_000_000;
    const realDateNow = Date.now;
    Date.now = (): number => now;
    server.use(
      http.get(
        `${API_BASE}/jobs/job-wait-429`,
        () =>
          new HttpResponse(JSON.stringify({ detail: "slow down" }), {
            status: 429,
            headers: { "Retry-After": "999", "Content-Type": "application/json" },
          }),
      ),
    );
    const cap = captureStreams();
    try {
      await expect(
        jobsWatchCommand({
          jobId: "job-wait-429",
          apiBase: API_BASE,
          token: TOKEN,
          // Advance clock past the deadline during the retry sleep so the
          // next iteration sees `deadlineReached()` true.
          sleepFn: async () => {
            now += 5_000;
          },
          isTTY: false,
          totalTimeoutMs: 1000,
        }),
      ).rejects.toThrow(/__exit__:1/);
      expect(cap.exitCode).toBe(1);
      const envelopeLine = cap.stderr
        .trim()
        .split("\n")
        .find((l) => l.includes('"error"'));
      expect(envelopeLine).toBeDefined();
      const env = JSON.parse(envelopeLine!);
      expect(env.error.code).toBe("generic");
      expect(env.error.message).toMatch(/Timed out waiting/);
    } finally {
      Date.now = realDateNow;
    }
  });

  it("--wait deadline fires across alternating retryable failures (mixed streak)", async () => {
    // Alternating 503/429 indefinitely must terminate via --wait, not run
    // forever. Before the deadline-at-top-of-loop fix the watch only checked
    // the deadline on a successful poll, so a continuous retry stream could
    // race past --wait.
    let now = 1_000_000;
    const realDateNow = Date.now;
    Date.now = (): number => now;
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/jobs/job-wait-mix`, () => {
        calls += 1;
        if (calls % 2 === 1) {
          return HttpResponse.json(
            { detail: "upstream", error: { retryable: true } },
            { status: 503 },
          );
        }
        return new HttpResponse(JSON.stringify({ detail: "slow down" }), {
          status: 429,
          headers: { "Retry-After": "1", "Content-Type": "application/json" },
        });
      }),
    );
    const cap = captureStreams();
    try {
      await expect(
        jobsWatchCommand({
          jobId: "job-wait-mix",
          apiBase: API_BASE,
          token: TOKEN,
          sleepFn: async () => {
            now += 600;
          },
          isTTY: false,
          totalTimeoutMs: 1000,
        }),
      ).rejects.toThrow(/__exit__:1/);
      expect(cap.exitCode).toBe(1);
      const envelopeLine = cap.stderr
        .trim()
        .split("\n")
        .find((l) => l.includes('"error"'));
      const env = JSON.parse(envelopeLine!);
      expect(env.error.code).toBe("generic");
      expect(env.error.message).toMatch(/Timed out waiting/);
    } finally {
      Date.now = realDateNow;
    }
  });

  it("--wait clamps the per-request HTTP timeout to remaining budget", async () => {
    // Codex regression: without clamping the per-request HTTP timeout to
    // the remaining --wait budget, a hung GET /jobs/{id} can block for up
    // to `--timeout` (60s default) before the watch loop next checks the
    // wall-clock deadline. With clamping, the AbortController fires within
    // the remaining budget, the loop logs a transient error, and the next
    // iteration exits via the generic timeout path. Test uses real timers
    // because AbortController honors real setTimeout in the http layer.
    server.use(
      http.get(
        `${API_BASE}/jobs/job-hang`,
        () => new Promise<Response>(() => {}),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-hang",
        apiBase: API_BASE,
        token: TOKEN,
        timeoutMs: 30_000, // generous per-request budget
        totalTimeoutMs: 150, // tight --wait budget
        sleepFn: async () => {}, // skip retry-branch sleep
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:1/);
    expect(cap.exitCode).toBe(1);
    const envelopeLine = cap.stderr
      .trim()
      .split("\n")
      .find((l) => l.includes('"error"'));
    expect(envelopeLine).toBeDefined();
    const env = JSON.parse(envelopeLine!);
    expect(env.error.code).toBe("generic");
    expect(env.error.message).toMatch(/Timed out waiting/);
  }, 5_000);

  it("non-retryable error (404) terminates watch immediately, no retries", async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/jobs/job-404`, () => {
        calls += 1;
        return HttpResponse.json({ detail: "Job not found" }, { status: 404 });
      }),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-404",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:6/);
    expect(cap.exitCode).toBe(6);
    expect(calls).toBe(1);
  });

  it("Ctrl-C handler does NOT call DELETE /jobs/{id}", async () => {
    // We assert by ensuring jobsWatchCommand exposes a cancel path that prints
    // a hint to stderr and exits 130 — and that path does NOT issue a DELETE.
    let deleteCalled = false;
    server.use(
      http.get(`${API_BASE}/jobs/job-sig`, () =>
        HttpResponse.json({
          job_id: "job-sig",
          status: "running",
          module_type: "free-tier",
          next_poll_ms: 1,
        }),
      ),
      http.delete(`${API_BASE}/jobs/:id`, () => {
        deleteCalled = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    const cap = captureStreams();
    // Trigger sigint by passing simulated signal flag
    await expect(
      jobsWatchCommand({
        jobId: "job-sig",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
        __simulateSigint: true,
      }),
    ).rejects.toThrow(/__exit__:130/);
    expect(cap.exitCode).toBe(130);
    expect(deleteCalled).toBe(false);
    expect(cap.stderr).toMatch(/resume watch|still running/i);
    // Codex regression: in non-TTY mode every stderr line must be valid
    // NDJSON. The SIGINT resume hint formerly used printProgress() plain
    // text, which broke any agent parsing stderr line-by-line.
    const stderrLines = cap.stderr.trim().split("\n").filter(Boolean);
    for (const line of stderrLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const hintRecord = stderrLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r["event"] === "sigint");
    expect(hintRecord).toBeDefined();
    expect(hintRecord!["job_id"]).toBe("job-sig");
    expect(String(hintRecord!["hint"])).toMatch(/resume watch|still running/i);
  });
});

describe("diffmode jobs resume", () => {
  it("free-tier: GETs status then POSTs /free-tier/{product_id}/retry", async () => {
    let retried = false;
    server.use(
      http.get(`${API_BASE}/jobs/old-job`, () =>
        HttpResponse.json({
          job_id: "old-job",
          status: "interrupted",
          module_type: "free-tier",
          product_id: "acme",
        }),
      ),
      http.post(`${API_BASE}/free-tier/acme/retry`, async ({ request }) => {
        retried = true;
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toEqual({});
        return HttpResponse.json(
          { job_id: "new-job", status: "pending", module_type: "free-tier" },
          { status: 202 },
        );
      }),
    );
    const cap = captureStreams();
    await jobsResumeCommand({
      jobId: "old-job",
      apiBase: API_BASE,
      token: TOKEN,
    });
    expect(retried).toBe(true);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.job_id).toBe("new-job");
  });

  it("workflow: GETs status then POSTs /workflow/resume with `product_id` body", async () => {
    let resumeBody: unknown = null;
    server.use(
      http.get(`${API_BASE}/jobs/old-wf`, () =>
        HttpResponse.json({
          job_id: "old-wf",
          status: "interrupted",
          module_type: "workflow",
          product_id: "acme",
        }),
      ),
      http.post(`${API_BASE}/workflow/resume`, async ({ request }) => {
        resumeBody = await request.json();
        return HttpResponse.json(
          { job_id: "new-wf", status: "pending", module_type: "workflow" },
          { status: 202 },
        );
      }),
    );
    const cap = captureStreams();
    await jobsResumeCommand({
      jobId: "old-wf",
      apiBase: API_BASE,
      token: TOKEN,
    });
    // Backend's WorkflowResumeRequest requires product_id (min_length=1).
    expect(resumeBody).toEqual({ product_id: "acme" });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.job_id).toBe("new-wf");
  });

  it("workflow: usage error when status response is missing product_id", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/old-wf2`, () =>
        HttpResponse.json({
          job_id: "old-wf2",
          status: "interrupted",
          module_type: "workflow",
          // intentionally missing product_id
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsResumeCommand({
        jobId: "old-wf2",
        apiBase: API_BASE,
        token: TOKEN,
      }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("usage");
    expect(err.error.message).toMatch(/product_id/);
  });

  it("idea-eval: not resumable → exit 2 with resubmit hint", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/ie-old`, () =>
        HttpResponse.json({
          job_id: "ie-old",
          status: "interrupted",
          module_type: "idea-eval",
          product_id: "acme",
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsResumeCommand({
        jobId: "ie-old",
        apiBase: API_BASE,
        token: TOKEN,
      }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("usage");
    expect(err.error.message).toMatch(/not resumable|resubmit/i);
  });

  it("smoke-test: not resumable → exit 2", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/st-old`, () =>
        HttpResponse.json({
          job_id: "st-old",
          status: "interrupted",
          module_type: "smoke-test",
          product_id: "acme",
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsResumeCommand({
        jobId: "st-old",
        apiBase: API_BASE,
        token: TOKEN,
      }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
  });

  it("unlock: not resumable → exit 2", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/un-old`, () =>
        HttpResponse.json({
          job_id: "un-old",
          status: "interrupted",
          module_type: "unlock",
          product_id: "acme",
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsResumeCommand({
        jobId: "un-old",
        apiBase: API_BASE,
        token: TOKEN,
      }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
  });
});

describe("diffmode jobs cancel", () => {
  it("aborts cleanly when confirmFn returns false (does not call DELETE)", async () => {
    // Reproduces the bug where the TTY prompt never resolved on stdin EOF —
    // here we use an injected confirmFn that returns false to assert the
    // command exits without issuing the DELETE.
    let deleted = false;
    server.use(
      http.delete(`${API_BASE}/jobs/job-no-confirm`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const cap = captureStreams();
    // Force TTY path so the confirmFn branch fires. Gating is on
    // process.stdin.isTTY (not stdout) so piping `--json | jq` still
    // prompts the user — we drive stdin.isTTY here.
    const origDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      "isTTY",
    );
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      get: () => true,
    });
    try {
      await expect(
        jobsCancelCommand({
          jobId: "job-no-confirm",
          apiBase: API_BASE,
          token: TOKEN,
          confirmFn: async () => false,
        }),
      ).rejects.toThrow(/__exit__:2/);
      expect(cap.exitCode).toBe(2);
      expect(deleted).toBe(false);
    } finally {
      if (origDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", origDescriptor);
      } else {
        delete (process.stdin as unknown as Record<string, unknown>)["isTTY"];
      }
    }
  });

  it("piped stdout but interactive stdin still prompts (no DELETE without confirmation)", async () => {
    let deleted = false;
    server.use(
      http.delete(`${API_BASE}/jobs/job-pipe`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const cap = captureStreams();
    const origStdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const origStdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      get: () => false,
    });
    try {
      await expect(
        jobsCancelCommand({
          jobId: "job-pipe",
          apiBase: API_BASE,
          token: TOKEN,
          confirmFn: async () => false,
        }),
      ).rejects.toThrow(/__exit__:2/);
      expect(cap.exitCode).toBe(2);
      expect(deleted).toBe(false);
    } finally {
      if (origStdin) {
        Object.defineProperty(process.stdin, "isTTY", origStdin);
      } else {
        delete (process.stdin as unknown as Record<string, unknown>)["isTTY"];
      }
      if (origStdout) {
        Object.defineProperty(process.stdout, "isTTY", origStdout);
      } else {
        delete (process.stdout as unknown as Record<string, unknown>)["isTTY"];
      }
    }
  });

  it("DELETEs /jobs/{id} and exits 0", async () => {
    let deleted = false;
    server.use(
      http.delete(`${API_BASE}/jobs/job-cancel`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const cap = captureStreams();
    await jobsCancelCommand({
      jobId: "job-cancel",
      apiBase: API_BASE,
      token: TOKEN,
      yes: true,
    });
    expect(deleted).toBe(true);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.cancelled).toBe(true);
  });

  it("exits 6 on 404", async () => {
    server.use(
      http.delete(`${API_BASE}/jobs/no-such`, () =>
        HttpResponse.json({ detail: "Job not found" }, { status: 404 }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsCancelCommand({
        jobId: "no-such",
        apiBase: API_BASE,
        token: TOKEN,
        yes: true,
      }),
    ).rejects.toThrow(/__exit__:6/);
    expect(cap.exitCode).toBe(6);
  });
});
