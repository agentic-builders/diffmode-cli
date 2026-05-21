import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOutputConfig, setOutputConfig } from "../src/lib/output";
import { resultsCommand } from "../src/commands/results";

const API_BASE = "https://api.test/public/v1";
const TOKEN = "dm_pat_results_token_xxxxxxxxxxxxxxxx";

type Captured = { stdout: string; stderr: string; exitCode?: number };
function captureStreams(): Captured {
  const captured: Captured = { stdout: "", stderr: "" };
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    captured.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    captured.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured.exitCode = code ?? 0;
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never);
  return captured;
}

const server = setupServer();
let tmp: string;

beforeEach(() => {
  server.listen({ onUnhandledRequest: "error" });
  resetOutputConfig();
  setOutputConfig({ json: true });
  tmp = mkdtempSync(join(tmpdir(), "diffmode-results-"));
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  vi.restoreAllMocks();
  resetOutputConfig();
  rmSync(tmp, { recursive: true, force: true });
});

function freeTierReportPayload(): Record<string, unknown> {
  return {
    meta: {
      schemaVersion: "1",
      reportId: "r1",
      customerId: "c1",
      productName: "Acme",
      generatedAt: "2026-05-20T00:00:00Z",
      tier: "free",
    },
    landscape: { keyFinding: { heading: "L-finding", body: "L body" } },
    advantages: { keyFinding: { heading: "A-finding", body: "A body" } },
    buyers: { keyFinding: { heading: "B-finding", body: "B body" } },
    blockers: { keyFinding: { heading: "Blockers", body: "X body" } },
    growthPlan: { keyFinding: { heading: "Growth", body: "G body" } },
  };
}

function mockFreeTierJob(productId = "acme", jobId = "job-free-1"): void {
  server.use(
    http.get(`${API_BASE}/jobs`, () =>
      HttpResponse.json({
        jobs: [
          {
            job_id: jobId,
            status: "completed",
            module_type: "free-tier",
            product_id: productId,
            created_at: "2026-05-20T00:00:00Z",
          },
        ],
        total: 1,
        next_cursor: null,
      }),
    ),
    http.get(`${API_BASE}/products/${productId}/outputs`, () =>
      HttpResponse.json({
        product_id: productId,
        files: [
          { path: "04-report/report.json", content: JSON.stringify(freeTierReportPayload()) },
          { path: "01-research/tactics.md", content: "# Tactics body\n" },
        ],
        total_files: 2,
        truncated: false,
      }),
    ),
    http.get(`${API_BASE}/products/${productId}/report`, () =>
      HttpResponse.json(freeTierReportPayload()),
    ),
  );
}

describe("diffmode results <product> (default)", () => {
  it("emits a schema-versioned manifest JSON for free-tier", async () => {
    mockFreeTierJob();
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
    });
    const lines = cap.stdout.trim().split("\n").filter(Boolean);
    const last = lines[lines.length - 1]!;
    const parsed = JSON.parse(last);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.product).toBe("acme");
    expect(parsed.job_id).toBe("job-free-1");
    expect(parsed.module_type).toBe("free-tier");
    expect(parsed.total_files).toBe(2);
    expect(parsed.total_bytes_est).toBeGreaterThan(0);
    expect(Array.isArray(parsed.report_sections)).toBe(true);
    expect(parsed.report_sections).toEqual(
      expect.arrayContaining(["meta", "landscape", "advantages", "buyers", "blockers", "growthPlan"]),
    );
    // out_dir resolves under <outBase>/<product>/<job>
    expect(String(parsed.out_dir)).toContain("acme/job-free-1");
  });

  it("downloads all output files into outDir", async () => {
    mockFreeTierJob();
    captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
    });
    const reportPath = join(tmp, "acme/job-free-1/04-report/report.json");
    const tacticsPath = join(tmp, "acme/job-free-1/01-research/tactics.md");
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(tacticsPath)).toBe(true);
    expect(readFileSync(tacticsPath, "utf-8")).toBe("# Tactics body\n");
  });

  it("--out overrides default base directory", async () => {
    mockFreeTierJob();
    captureStreams();
    const customOut = join(tmp, "custom");
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      out: customOut,
    });
    expect(existsSync(join(customOut, "04-report/report.json"))).toBe(true);
  });

  it("exits with NOT_FOUND when no completed job exists", async () => {
    server.use(
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({ jobs: [], total: 0, next_cursor: null }),
      ),
    );
    const cap = captureStreams();
    await expect(
      resultsCommand({
        product: "ghost",
        apiBase: API_BASE,
        token: TOKEN,
        outBase: tmp,
      }),
    ).rejects.toThrow(/__exit__:6/);
    expect(cap.exitCode).toBe(6);
    const err = JSON.parse(cap.stderr.trim().split("\n").pop()!);
    expect(err.error.code).toBe("not_found");
  });
});

describe("diffmode results <product> --job-id drift", () => {
  function mockDriftScenario(): void {
    server.use(
      // Explicit --job-id lookup: resolveLatestCompletedJob hits
      // GET /jobs/{id} directly when jobId is set.
      http.get(`${API_BASE}/jobs/old-job`, () =>
        HttpResponse.json({
          job_id: "old-job",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-19T00:00:00Z",
        }),
      ),
      // Latest-completed lookup: list query filtered by product+status.
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({
          jobs: [
            {
              job_id: "latest-job",
              status: "completed",
              module_type: "free-tier",
              product_id: "acme",
              created_at: "2026-05-20T00:00:00Z",
            },
          ],
          total: 1,
          next_cursor: null,
        }),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "04-report/report.json", content: JSON.stringify(freeTierReportPayload()) },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json(freeTierReportPayload()),
      ),
    );
  }

  it("--quiet still surfaces drift via manifest `latest_completed_job_id`", async () => {
    // Codex regression: drift warning via printProgress is silenced by
    // --quiet, leaving agents with no signal that downloaded files
    // reflect a different job than the pinned --job-id. The manifest
    // field must carry the drift even under --quiet.
    mockDriftScenario();
    setOutputConfig({ quiet: true });
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
    });
    expect(cap.stderr).toBe(""); // --quiet suppresses progress
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.job_id).toBe("old-job");
    expect(parsed.latest_completed_job_id).toBe("latest-job");
  });

  it("transient 503 on advisory drift lookup does NOT abort the download", async () => {
    // Codex regression: the second `resolveLatestCompletedJob` call (the
    // drift advisory) used to be a hard dependency of `--job-id` mode. A
    // 429/5xx/network blip on that lookup would throw out of
    // `resolveAndDownload` before the artifact download ran, turning
    // informational metadata into a new failure mode. The advisory lookup
    // must be best-effort: drift field stays absent, download still
    // succeeds, command exits 0.
    server.use(
      http.get(`${API_BASE}/jobs/old-job`, () =>
        HttpResponse.json({
          job_id: "old-job",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-19T00:00:00Z",
        }),
      ),
      // Advisory drift lookup fails — must not propagate.
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json(
          { detail: "upstream timeout", error: { retryable: true } },
          { status: 503 },
        ),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "04-report/report.json", content: JSON.stringify(freeTierReportPayload()) },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json(freeTierReportPayload()),
      ),
    );
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
    });
    expect(cap.exitCode).toBeUndefined(); // success path — no process.exit
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.job_id).toBe("old-job");
    expect(parsed.total_files).toBe(1);
    // Drift unknowable → omit the field, don't lie with a stale value.
    expect(parsed.latest_completed_job_id).toBeUndefined();
    // Quarantine under `-unverified` so any pre-existing pinned snapshot stays intact.
    expect(String(parsed.out_dir)).toContain(`acme${"/"}old-job-unverified`);
    expect(existsSync(join(tmp, "acme/old-job-unverified/04-report/report.json"))).toBe(true);
  });

  it("--summary --quiet surfaces drift via `latest_completed_job_id`", async () => {
    // Drift signal must reach every JSON output mode, not just the default
    // manifest. Without this, agents using `--summary --job-id X --quiet`
    // get no signal that downloaded files don't belong to X.
    mockDriftScenario();
    setOutputConfig({ quiet: true });
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
      summary: true,
    });
    expect(cap.stderr).toBe("");
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.job_id).toBe("old-job");
    expect(parsed.latest_completed_job_id).toBe("latest-job");
  });

  it("--stage --quiet surfaces drift via `latest_completed_job_id`", async () => {
    mockDriftScenario();
    setOutputConfig({ quiet: true });
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
      stage: "landscape",
    });
    expect(cap.stderr).toBe("");
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.job_id).toBe("old-job");
    expect(parsed.latest_completed_job_id).toBe("latest-job");
  });

  it("--tactic --quiet surfaces drift via `latest_completed_job_id`", async () => {
    // Mock a report with a growthPlan.tactics array so --tactic can match.
    server.use(
      http.get(`${API_BASE}/jobs/old-job`, () =>
        HttpResponse.json({
          job_id: "old-job",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-19T00:00:00Z",
        }),
      ),
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({
          jobs: [
            {
              job_id: "latest-job",
              status: "completed",
              module_type: "free-tier",
              product_id: "acme",
              created_at: "2026-05-20T00:00:00Z",
            },
          ],
          total: 1,
          next_cursor: null,
        }),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [{ path: "report.json", content: "{}" }],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json({
          ...freeTierReportPayload(),
          growthPlan: {
            keyFinding: { heading: "Growth", body: "G body" },
            tactics: [{ id: "t1", name: "Tactic One" }],
          },
        }),
      ),
    );
    setOutputConfig({ quiet: true });
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
      tactic: "t1",
    });
    expect(cap.stderr).toBe("");
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.job_id).toBe("old-job");
    expect(parsed.latest_completed_job_id).toBe("latest-job");
  });

  it("--pull --quiet still surfaces drift on stderr (integrity bypasses quiet)", async () => {
    // --pull has no JSON envelope to carry latest_completed_job_id, so the
    // stderr drift warning must bypass --quiet — otherwise agents using
    // `--pull --job-id X --quiet` get zero signal of an integrity issue.
    mockDriftScenario();
    setOutputConfig({ quiet: true });
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
      pull: true,
    });
    expect(cap.stdout).toBe("");
    expect(cap.stderr).toContain("latest-job");
    expect(cap.stderr).toContain("old-job");
  });

  it("--show --quiet still surfaces drift on stderr (integrity bypasses quiet)", async () => {
    // --show streams raw file content to stdout with no JSON envelope, so
    // drift bypasses --quiet on stderr to preserve the integrity signal.
    // Explicitly clear `json` (set globally in beforeEach) to exercise the
    // cat-style raw path — `--json` opts into the `{path, contents}` envelope
    // and the drift warning then lives in the JSON output mode under --quiet.
    mockDriftScenario();
    setOutputConfig({ json: false, quiet: true });
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
      show: "04-report/report.json",
    });
    expect(cap.stdout).toContain("\"landscape\"");
    expect(cap.stderr).toContain("latest-job");
  });

  it("--show --json emits a {path, contents} envelope (matches skill show contract)", async () => {
    // README claims --show + --json mirrors `skill show` — verify the
    // envelope is produced and the file body is the contents string.
    mockDriftScenario();
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
      show: "04-report/report.json",
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.path).toBe("04-report/report.json");
    expect(typeof parsed.contents).toBe("string");
    expect(parsed.contents).toContain("landscape");
    expect(parsed.truncated).toBeUndefined();
    // Drift detected (--job-id old-job, latest is latest-job) — the JSON
    // envelope must carry the integrity signal even when --show is the mode.
    expect(parsed.latest_completed_job_id).toBe("latest-job");
  });

  it("--show --json --quiet surfaces drift via `latest_completed_job_id`", async () => {
    // Codex regression: drift via printProgress is silenced by --quiet on
    // every output mode. The --show JSON envelope must carry the same
    // machine-readable drift fields the manifest/--summary/--stage/--tactic
    // paths do, or agents pinning --job-id will silently trust the snapshot.
    mockDriftScenario();
    setOutputConfig({ quiet: true });
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
      show: "04-report/report.json",
    });
    expect(cap.stderr).toBe(""); // --quiet suppresses progress
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.path).toBe("04-report/report.json");
    expect(parsed.latest_completed_job_id).toBe("latest-job");
  });

  it("--show --json --quiet surfaces advisory-lookup failure via `drift_lookup_failed`", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/old-job`, () =>
        HttpResponse.json({
          job_id: "old-job",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-19T00:00:00Z",
        }),
      ),
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json(
          { detail: "upstream timeout", error: { retryable: true } },
          { status: 503 },
        ),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "04-report/report.json", content: JSON.stringify(freeTierReportPayload()) },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json(freeTierReportPayload()),
      ),
    );
    setOutputConfig({ quiet: true });
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
      show: "04-report/report.json",
    });
    expect(cap.stderr).toBe("");
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.path).toBe("04-report/report.json");
    expect(parsed.drift_lookup_failed).toBe(true);
    expect(parsed.latest_completed_job_id).toBeUndefined();
  });

  it("--show --json --max-tokens marks the envelope `truncated: true`", async () => {
    mockFreeTierJob();
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      show: "01-research/tactics.md",
      maxTokens: 2,
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.path).toBe("01-research/tactics.md");
    expect(parsed.truncated).toBe(true);
    expect(parsed.contents).toMatch(/truncated/);
  });

  it("with --out on drift, honors the user-pinned path and warns honestly (no auto-redirect)", async () => {
    // Codex regression: `--out <dir>` is user-explicit ownership of the
    // destination; the CLI does NOT auto-redirect to `<latest-job>/` because
    // the user asked for that exact path. The stderr drift warning must
    // acknowledge that — claiming "to avoid overwriting any prior snapshot"
    // would be a lie on this path. Verify the file lands at --out and the
    // warning text explicitly flags `--out` + no auto-redirect.
    mockDriftScenario();
    setOutputConfig({ json: false }); // cat-style path → stderr is the only drift signal
    const cap = captureStreams();
    const customOut = join(tmp, "custom-out");
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      out: customOut,
      jobId: "old-job",
      pull: true, // silent download path; stderr carries the only warning
    });
    // Files land at --out verbatim — no `<latest-job>/` redirect inserted.
    expect(existsSync(join(customOut, "04-report/report.json"))).toBe(true);
    expect(existsSync(join(tmp, "acme/latest-job"))).toBe(false);
    // Warning honestly states `--out` is in effect and no protection applied.
    expect(cap.stderr).toMatch(/--out/);
    expect(cap.stderr).toMatch(/no auto-redirect/i);
    // It must NOT carry the redirect-style "to avoid overwriting" phrasing
    // that the default / --out-base paths use; that phrasing implies
    // protection happened, which is false here.
    expect(cap.stderr).not.toMatch(/to avoid overwriting/i);
  });

  it("with --out on advisory failure, honors the user-pinned path and warns honestly (no auto-quarantine)", async () => {
    // Codex regression: same as the confirmed-drift case but on the
    // advisory-lookup-failed path. `<pinned-job>-unverified/` quarantine does
    // NOT apply when the user pinned `--out`; the warning must say so
    // instead of claiming the snapshot was quarantined.
    server.use(
      http.get(`${API_BASE}/jobs/old-job`, () =>
        HttpResponse.json({
          job_id: "old-job",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-19T00:00:00Z",
        }),
      ),
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json(
          { detail: "upstream timeout", error: { retryable: true } },
          { status: 503 },
        ),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "04-report/report.json", content: JSON.stringify(freeTierReportPayload()) },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json(freeTierReportPayload()),
      ),
    );
    setOutputConfig({ json: false });
    const cap = captureStreams();
    const customOut = join(tmp, "custom-out-uv");
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      out: customOut,
      jobId: "old-job",
      pull: true,
    });
    // Files land at --out verbatim — no `-unverified` suffix appended.
    expect(existsSync(join(customOut, "04-report/report.json"))).toBe(true);
    expect(existsSync(`${customOut}-unverified`)).toBe(false);
    // Warning honestly states `--out` is in effect and no quarantine applied.
    expect(cap.stderr).toMatch(/--out/);
    expect(cap.stderr).toMatch(/no auto-quarantine/i);
    expect(cap.stderr).not.toMatch(/quarantined under -unverified/i);
  });

  it("on drift, writes into the latest-job dir, not the pinned-job dir (no overwrite)", async () => {
    // Outputs are product-scoped in Phase 1, so files belong to whichever
    // job ran most recently — never the pinned manifest job. Writing them
    // into `<pinned>/` would silently corrupt any prior snapshot kept
    // there. Verify the redirect happens AND the pinned dir is left alone.
    mockDriftScenario();
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.job_id).toBe("old-job");
    expect(parsed.latest_completed_job_id).toBe("latest-job");
    expect(String(parsed.out_dir)).toContain(`acme${"/"}latest-job`);
    expect(existsSync(join(tmp, "acme/latest-job/04-report/report.json"))).toBe(true);
    expect(existsSync(join(tmp, "acme/old-job/04-report/report.json"))).toBe(false);
  });

  it("on advisory failure, quarantines under `<pinned-job>-unverified/` so a real pinned snapshot is left untouched", async () => {
    // Codex regression: when the advisory drift lookup fails we cannot tell
    // whether the workspace matches the pinned job. Writing into
    // `<pinned-job>/` would silently overwrite a real prior snapshot living
    // there. Verify the redirect to `-unverified` AND that an existing
    // pinned-dir file survives untouched.
    server.use(
      http.get(`${API_BASE}/jobs/old-job`, () =>
        HttpResponse.json({
          job_id: "old-job",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-19T00:00:00Z",
        }),
      ),
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json(
          { detail: "upstream timeout", error: { retryable: true } },
          { status: 503 },
        ),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "04-report/report.json", content: JSON.stringify(freeTierReportPayload()) },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json(freeTierReportPayload()),
      ),
    );
    // Seed a pre-existing pinned snapshot with content the new download
    // would otherwise overwrite. If we wrote into `acme/old-job/` blindly
    // this file would be replaced — assert it stays exactly as written.
    const priorReport = join(tmp, "acme/old-job/04-report/report.json");
    const { mkdirSync: mkdir, writeFileSync: writeFile } = await import("node:fs");
    mkdir(join(tmp, "acme/old-job/04-report"), { recursive: true });
    writeFile(priorReport, '{"sentinel":"prior-snapshot-untouched"}');
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.drift_lookup_failed).toBe(true);
    expect(String(parsed.out_dir)).toContain(`acme${"/"}old-job-unverified`);
    // Quarantined download landed under -unverified, NOT in the pinned dir.
    expect(existsSync(join(tmp, "acme/old-job-unverified/04-report/report.json"))).toBe(true);
    // Original pinned snapshot must be byte-for-byte preserved.
    expect(readFileSync(priorReport, "utf-8")).toBe(
      '{"sentinel":"prior-snapshot-untouched"}',
    );
  });

  it("on repeated advisory failure, the quarantine dir is reset so two pulls don't mix", async () => {
    // Codex regression: `downloadProductOutputs()` writes/skips files in the
    // payload but never prunes files that disappeared, so two consecutive
    // advisory-failure pulls into the same `<pinned>-unverified/` dir would
    // leave a stale file from pull #1 alongside updated files from pull #2.
    // That defeats the per-pull quarantine semantic — each unverified pull
    // must be a coherent snapshot of the workspace at that moment, not a
    // merge of multiple "unknown drift" pulls.
    const handlerOldJob = http.get(`${API_BASE}/jobs/old-job`, () =>
      HttpResponse.json({
        job_id: "old-job",
        status: "completed",
        module_type: "free-tier",
        product_id: "acme",
        created_at: "2026-05-19T00:00:00Z",
      }),
    );
    const advisoryFail = http.get(`${API_BASE}/jobs`, () =>
      HttpResponse.json(
        { detail: "upstream timeout", error: { retryable: true } },
        { status: 503 },
      ),
    );
    const reportHandler = http.get(`${API_BASE}/products/acme/report`, () =>
      HttpResponse.json(freeTierReportPayload()),
    );
    // Pull #1: workspace has two files, one of which (gone.md) will vanish
    // by pull #2. If the dir isn't reset, gone.md will haunt pull #2.
    server.use(
      handlerOldJob,
      advisoryFail,
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "04-report/report.json", content: '{"v":1}' },
            { path: "01-research/gone.md", content: "will-disappear\n" },
          ],
          total_files: 2,
          truncated: false,
        }),
      ),
      reportHandler,
    );
    captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
    });
    const quarantineDir = join(tmp, "acme/old-job-unverified");
    expect(existsSync(join(quarantineDir, "01-research/gone.md"))).toBe(true);

    // Pull #2: workspace no longer has gone.md and has an updated report.
    server.resetHandlers();
    server.use(
      handlerOldJob,
      advisoryFail,
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "04-report/report.json", content: '{"v":2}' },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
      reportHandler,
    );
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
    });
    // gone.md from pull #1 must NOT survive into pull #2 — the quarantine
    // dir is reset before each advisory-failure download.
    expect(existsSync(join(quarantineDir, "01-research/gone.md"))).toBe(false);
    // Updated report content reflects pull #2 only.
    expect(
      readFileSync(join(quarantineDir, "04-report/report.json"), "utf-8"),
    ).toBe('{"v":2}');
  });

  it("on advisory failure, marks `drift_lookup_failed: true` and warns on stderr", async () => {
    // Without this signal, agents using `--job-id` could silently trust the
    // snapshot even though we couldn't verify drift status. The manifest
    // field is the machine-readable hook; the stderr note is the human aid.
    server.use(
      http.get(`${API_BASE}/jobs/old-job`, () =>
        HttpResponse.json({
          job_id: "old-job",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-19T00:00:00Z",
        }),
      ),
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json(
          { detail: "upstream timeout", error: { retryable: true } },
          { status: 503 },
        ),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "04-report/report.json", content: JSON.stringify(freeTierReportPayload()) },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json(freeTierReportPayload()),
      ),
    );
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "old-job",
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.job_id).toBe("old-job");
    expect(parsed.latest_completed_job_id).toBeUndefined();
    expect(parsed.drift_lookup_failed).toBe(true);
    expect(cap.stderr).toMatch(/could not be verified/i);
  });

  it("without drift (pinned job IS the latest), no `latest_completed_job_id` field", async () => {
    mockFreeTierJob("acme", "job-free-1");
    // resolveLatestCompletedJob hits GET /jobs/{id} when --job-id is set.
    server.use(
      http.get(`${API_BASE}/jobs/job-free-1`, () =>
        HttpResponse.json({
          job_id: "job-free-1",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-20T00:00:00Z",
        }),
      ),
    );
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      jobId: "job-free-1",
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.job_id).toBe("job-free-1");
    expect(parsed.latest_completed_job_id).toBeUndefined();
  });
});

describe("diffmode results <product> --pull", () => {
  it("downloads silently with no manifest JSON on stdout", async () => {
    mockFreeTierJob();
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      pull: true,
    });
    expect(cap.stdout).toBe("");
    expect(existsSync(join(tmp, "acme/job-free-1/04-report/report.json"))).toBe(true);
  });
});

describe("diffmode results <product> --summary", () => {
  it("prints free-tier keyFinding sections", async () => {
    mockFreeTierJob();
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      summary: true,
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.landscape.heading).toBe("L-finding");
    expect(parsed.summary.advantages.heading).toBe("A-finding");
    expect(parsed.summary.buyers.heading).toBe("B-finding");
    expect(parsed.summary.blockers.heading).toBe("Blockers");
  });

  it("for workflow module prints a Phase-2 stub", async () => {
    server.use(
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({
          jobs: [
            {
              job_id: "wf-1",
              status: "completed",
              module_type: "workflow",
              product_id: "acme",
              created_at: "2026-05-20T00:00:00Z",
            },
          ],
          total: 1,
          next_cursor: null,
        }),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [{ path: "x.md", content: "hi" }],
          total_files: 1,
          truncated: false,
        }),
      ),
    );
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      summary: true,
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.summary.stub).toBe(true);
    expect(parsed.summary.message).toMatch(/Phase 2/i);
  });
});

describe("diffmode results <product> --show <path>", () => {
  it("cats a single file from out_dir after download", async () => {
    mockFreeTierJob();
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      show: "01-research/tactics.md",
    });
    expect(cap.stdout).toContain("# Tactics body");
  });

  it("with --max-tokens truncates output and appends a footer", async () => {
    // tactics.md is ~16 chars => ~4 tokens. Force a 2-token cap.
    mockFreeTierJob();
    const cap = captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      outBase: tmp,
      show: "01-research/tactics.md",
      maxTokens: 2,
    });
    expect(cap.stdout).toMatch(/truncated/i);
  });

  it("exits 6 when --show path does not exist", async () => {
    mockFreeTierJob();
    const cap = captureStreams();
    await expect(
      resultsCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        outBase: tmp,
        show: "does/not/exist.md",
      }),
    ).rejects.toThrow(/__exit__:/);
    // Either USAGE (2) or NOT_FOUND (6) is acceptable for a missing path;
    // the implementation chooses USAGE so the agent gets a clear hint.
    expect([2, 6]).toContain(cap.exitCode);
  });
});

describe("diffmode results <product> --stage / --tactic", () => {
  it("for workflow module exits 2 with manifest-mode hint", async () => {
    server.use(
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({
          jobs: [
            {
              job_id: "wf-1",
              status: "completed",
              module_type: "workflow",
              product_id: "acme",
              created_at: "2026-05-20T00:00:00Z",
            },
          ],
          total: 1,
          next_cursor: null,
        }),
      ),
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [{ path: "x.md", content: "hi" }],
          total_files: 1,
          truncated: false,
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      resultsCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        outBase: tmp,
        stage: "synthesis",
      }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
    const err = JSON.parse(cap.stderr.trim().split("\n").pop()!);
    expect(err.error.message).toMatch(/manifest|Phase 2/i);
  });
});
