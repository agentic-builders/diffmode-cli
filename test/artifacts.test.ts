import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { HttpClient } from "../src/lib/http";
import {
  resolveLatestCompletedJob,
  downloadProductOutputs,
  downloadProductReport,
} from "../src/lib/artifacts";

const API_BASE = "https://api.test/public/v1";
const TOKEN = "dm_pat_artifacts_token_xxxxxxxxxxxxx";

const server = setupServer();

let tmp: string;

beforeEach(() => {
  server.listen({ onUnhandledRequest: "error" });
  tmp = mkdtempSync(join(tmpdir(), "diffmode-artifacts-"));
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

function buildClient(): HttpClient {
  return new HttpClient({ baseUrl: API_BASE, token: TOKEN });
}

describe("resolveLatestCompletedJob", () => {
  it("when --job-id given: GETs that job and verifies product matches", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-123`, () =>
        HttpResponse.json({
          job_id: "job-123",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
          created_at: "2026-05-20T12:00:00Z",
        }),
      ),
    );
    const info = await resolveLatestCompletedJob({
      client: buildClient(),
      product: "acme",
      jobId: "job-123",
    });
    expect(info).not.toBeNull();
    expect(info!.job_id).toBe("job-123");
    expect(info!.module_type).toBe("free-tier");
    expect(info!.product_id).toBe("acme");
  });

  it("when --job-id given but product mismatches: throws UsageError", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-other`, () =>
        HttpResponse.json({
          job_id: "job-other",
          status: "completed",
          module_type: "workflow",
          product_id: "other",
        }),
      ),
    );
    await expect(
      resolveLatestCompletedJob({
        client: buildClient(),
        product: "acme",
        jobId: "job-other",
      }),
    ).rejects.toThrow(/product/i);
  });

  it("when --job-id given but job is not completed: throws UsageError", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-running`, () =>
        HttpResponse.json({
          job_id: "job-running",
          status: "running",
          module_type: "free-tier",
          product_id: "acme",
        }),
      ),
    );
    await expect(
      resolveLatestCompletedJob({
        client: buildClient(),
        product: "acme",
        jobId: "job-running",
      }),
    ).rejects.toThrow(/'running'.*completed/);
  });

  it("without --job-id: queries /jobs with product+completed filter and takes newest", async () => {
    let observedUrl = "";
    server.use(
      http.get(`${API_BASE}/jobs`, ({ request }) => {
        observedUrl = request.url;
        return HttpResponse.json({
          jobs: [
            {
              job_id: "j-old",
              status: "completed",
              module_type: "free-tier",
              product_id: "acme",
              created_at: "2026-05-18T09:00:00Z",
            },
            {
              job_id: "j-new",
              status: "completed",
              module_type: "free-tier",
              product_id: "acme",
              created_at: "2026-05-20T18:00:00Z",
            },
          ],
          total: 2,
          next_cursor: null,
        });
      }),
    );
    const info = await resolveLatestCompletedJob({
      client: buildClient(),
      product: "acme",
    });
    expect(info).not.toBeNull();
    expect(info!.job_id).toBe("j-new");
    const url = new URL(observedUrl);
    expect(url.searchParams.get("product_id")).toBe("acme");
    expect(url.searchParams.get("status")).toBe("completed");
  });

  it("returns null when no completed jobs found", async () => {
    server.use(
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({ jobs: [], total: 0, next_cursor: null }),
      ),
    );
    const info = await resolveLatestCompletedJob({
      client: buildClient(),
      product: "acme",
    });
    expect(info).toBeNull();
  });
});

describe("downloadProductOutputs", () => {
  it("writes each output file to outDir, creating parent dirs", async () => {
    server.use(
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "01-research/tactics.md", content: "# Tactics\n" },
            { path: "04-report/report.json", content: '{"meta":{}}' },
          ],
          total_files: 2,
          truncated: false,
        }),
      ),
    );
    const outDir = join(tmp, "acme/job-1");
    const result = await downloadProductOutputs({
      client: buildClient(),
      product: "acme",
      outDir,
    });
    expect(existsSync(join(outDir, "01-research/tactics.md"))).toBe(true);
    expect(existsSync(join(outDir, "04-report/report.json"))).toBe(true);
    expect(readFileSync(join(outDir, "01-research/tactics.md"), "utf-8")).toBe(
      "# Tactics\n",
    );
    expect(result.files).toHaveLength(2);
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  it("writes files with mode 0644", async () => {
    server.use(
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [{ path: "x.md", content: "hello" }],
          total_files: 1,
          truncated: false,
        }),
      ),
    );
    const outDir = join(tmp, "out");
    await downloadProductOutputs({
      client: buildClient(),
      product: "acme",
      outDir,
    });
    const stat = statSync(join(outDir, "x.md"));
    // Mode low bits should be 0644 on POSIX
    const lowBits = stat.mode & 0o777;
    expect(lowBits).toBe(0o644);
  });

  it("skips write when local file already has identical content (idempotent)", async () => {
    const outDir = join(tmp, "acme/job-1");
    mkdirSync(join(outDir, "01-research"), { recursive: true });
    const localPath = join(outDir, "01-research/tactics.md");
    writeFileSync(localPath, "# Tactics\n");
    // Stamp an explicit mtime in the past so we can detect re-writes.
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(localPath, past, past);
    const beforeMtime = statSync(localPath).mtimeMs;

    server.use(
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [
            { path: "01-research/tactics.md", content: "# Tactics\n" },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
    );
    await downloadProductOutputs({
      client: buildClient(),
      product: "acme",
      outDir,
    });
    const afterMtime = statSync(localPath).mtimeMs;
    // Mtime untouched => the file was not re-written.
    expect(afterMtime).toBe(beforeMtime);
  });

  it("overwrites when local content differs", async () => {
    const outDir = join(tmp, "acme/job-1");
    mkdirSync(outDir, { recursive: true });
    const localPath = join(outDir, "x.md");
    writeFileSync(localPath, "old content");

    server.use(
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [{ path: "x.md", content: "new content" }],
          total_files: 1,
          truncated: false,
        }),
      ),
    );
    await downloadProductOutputs({
      client: buildClient(),
      product: "acme",
      outDir,
    });
    expect(readFileSync(localPath, "utf-8")).toBe("new content");
  });

  it("rejects paths that escape outDir (path traversal)", async () => {
    server.use(
      http.get(`${API_BASE}/products/acme/outputs`, () =>
        HttpResponse.json({
          product_id: "acme",
          files: [{ path: "../escape.md", content: "bad" }],
          total_files: 1,
          truncated: false,
        }),
      ),
    );
    const outDir = join(tmp, "out");
    await expect(
      downloadProductOutputs({
        client: buildClient(),
        product: "acme",
        outDir,
      }),
    ).rejects.toThrow(/escape|invalid|outside/i);
    // Confirm escape file never written
    expect(existsSync(join(dirname(outDir), "escape.md"))).toBe(false);
  });
});

describe("downloadProductReport", () => {
  it("GETs /products/{id}/report and returns the report payload", async () => {
    server.use(
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json({
          meta: { schemaVersion: "1", reportId: "r1", tier: "free" },
          landscape: { keyFinding: { heading: "L", body: "L body" } },
          advantages: { keyFinding: { heading: "A", body: "A body" } },
          buyers: { keyFinding: { heading: "B", body: "B body" } },
          blockers: { keyFinding: { heading: "X", body: "X body" } },
          growthPlan: {},
        }),
      ),
    );
    const report = await downloadProductReport({
      client: buildClient(),
      product: "acme",
    });
    expect(report).not.toBeNull();
    expect((report as { meta: { tier: string } }).meta.tier).toBe("free");
  });

  it("returns null on 404 (no report yet)", async () => {
    server.use(
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json({ detail: "no report" }, { status: 404 }),
      ),
    );
    const report = await downloadProductReport({
      client: buildClient(),
      product: "acme",
    });
    expect(report).toBeNull();
  });
});
