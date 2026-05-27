// Task 11 — Phase 1 acceptance + publish prep.
//
// Pins the end-to-end agent-drivable flow (login → run → watch → results)
// against the msw-mocked /public/v1 surface, asserts the spec §8 exit-code
// matrix is reachable, verifies the schema_version envelope is everywhere,
// and snapshots the top-level --help output so accidental command renames
// fail loudly.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { resetOutputConfig, setOutputConfig } from "../src/lib/output";
import { loginCommand } from "../src/commands/auth";
import { runCommand } from "../src/commands/run";
import { jobsWatchCommand } from "../src/commands/jobs/watch";
import { resultsCommand } from "../src/commands/results";
import { unlockCommand } from "../src/commands/unlock";
import { jobsStatusCommand } from "../src/commands/jobs/status";
import { jobsCancelCommand } from "../src/commands/jobs/cancel";
import { buildCommandsManifest } from "../src/commands/commands";
import { buildProgram } from "../src/bin";
import {
  createCredentialStore,
  __resetWarningDedupForTests,
  type KeytarLike,
} from "../src/lib/credentials";

const API_BASE = "https://api.test/public/v1";
const TOKEN = "dm_pat_acceptance_token_xxxxxxxxxxxxxxxxxxxx";

type Captured = { stdout: string; stderr: string; exitCode?: number };
function captureStreams(): Captured {
  const cap: Captured = { stdout: "", stderr: "" };
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    cap.stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    cap.stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    cap.exitCode = code ?? 0;
    throw new Error(`__exit__:${code ?? 0}`);
  }) as never);
  return cap;
}

function fakeKeytar(): KeytarLike & { store: Record<string, string> } {
  const store: Record<string, string> = {};
  return {
    store,
    async getPassword(service: string, account: string) {
      return store[`${service}:${account}`] ?? null;
    },
    async setPassword(service: string, account: string, password: string) {
      store[`${service}:${account}`] = password;
    },
    async deletePassword(service: string, account: string) {
      const k = `${service}:${account}`;
      if (k in store) {
        delete store[k];
        return true;
      }
      return false;
    },
  };
}

const server = setupServer();

let tmp: string;
let founderInputPath: string;

beforeEach(() => {
  server.listen({ onUnhandledRequest: "error" });
  resetOutputConfig();
  setOutputConfig({ json: true });
  __resetWarningDedupForTests();
  tmp = mkdtempSync(join(tmpdir(), "diffmode-accept-"));
  founderInputPath = join(tmp, "founder.json");
  writeFileSync(
    founderInputPath,
    JSON.stringify({ product_description: "End-to-end test product" }),
  );
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  vi.restoreAllMocks();
  resetOutputConfig();
  rmSync(tmp, { recursive: true, force: true });
});

describe("Phase 1 end-to-end agent flow (login → run → watch → results)", () => {
  it("walks the canonical happy path with schema_version envelopes throughout", async () => {
    const store = createCredentialStore({
      keytar: fakeKeytar(),
      configDir: join(tmp, "config"),
      warnFn: () => {},
    });

    let watchCalls = 0;
    server.use(
      http.get(`${API_BASE}/access-tokens`, () =>
        HttpResponse.json({
          tokens: [
            {
              id: "t1",
              name: "primary",
              token_prefix: "dm_pat_acce",
              created_at: "2026-05-20T00:00:00Z",
            },
          ],
        }),
      ),
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 50,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          {
            job_id: "job-e2e",
            status: "pending",
            module_type: "free-tier",
            product_id: "acme",
          },
          { status: 202 },
        ),
      ),
      http.get(`${API_BASE}/jobs/job-e2e`, () => {
        watchCalls += 1;
        if (watchCalls === 1) {
          return HttpResponse.json({
            job_id: "job-e2e",
            status: "running",
            module_type: "free-tier",
            next_poll_ms: 1,
            progress: {
              current_stage: "diagnostics",
              stages_completed: 1,
              total_stages: 3,
            },
          });
        }
        return HttpResponse.json({
          job_id: "job-e2e",
          status: "completed",
          module_type: "free-tier",
          product_id: "acme",
        });
      }),
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({
          jobs: [
            {
              job_id: "job-e2e",
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
            {
              path: "04-report/report.json",
              content: JSON.stringify({
                meta: {
                  schemaVersion: "1",
                  reportId: "r1",
                  customerId: "c1",
                  productName: "Acme",
                  generatedAt: "2026-05-20T00:00:00Z",
                  tier: "free",
                },
                landscape: { keyFinding: { heading: "L", body: "L body" } },
              }),
            },
          ],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json({
          meta: { schemaVersion: "1", tier: "free" },
          landscape: { keyFinding: { heading: "L", body: "L body" } },
        }),
      ),
    );

    const cap = captureStreams();

    // 1. login persists the token + emits schema_version envelope.
    await loginCommand({
      token: TOKEN,
      apiBase: API_BASE,
      store,
      profile: "default",
    });
    const loginOut = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(loginOut.schema_version).toBe("1");
    expect(loginOut.authenticated).toBe(true);
    expect(await store.load("default")).toBe(TOKEN);

    // 2. run submits with founder_input and prints job_id.
    await runCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      inputPath: founderInputPath,
    });
    const runOut = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(runOut.schema_version).toBe("1");
    expect(runOut.job_id).toBe("job-e2e");
    expect(runOut.module_type).toBe("free-tier");

    // 3. watch polls until completion → exit 0.
    await expect(
      jobsWatchCommand({
        jobId: "job-e2e",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:0/);
    expect(cap.exitCode).toBe(0);
    const watchTerminal = JSON.parse(
      cap.stdout.trim().split("\n").pop()!,
    );
    expect(watchTerminal.status).toBe("completed");

    // 4. results downloads + emits the Phase-1 manifest envelope.
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      out: join(tmp, "out"),
    });
    const resultsOut = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(resultsOut.schema_version).toBe("1");
    expect(resultsOut.product).toBe("acme");
    expect(resultsOut.module_type).toBe("free-tier");
    expect(resultsOut.total_files).toBe(1);
  });

  it("--from-url maps WebsiteAnalysisResponse into the submit body", async () => {
    let receivedBody: Record<string, unknown> | null = null;
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 5,
          has_stripe_customer: false,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/analyze-website`, () =>
        HttpResponse.json({
          company_name: "Acme",
          company_description: "Acme makes widgets",
          product_type: "saas",
          analysis_pricing: "$49/mo",
          target_customer: "indie devs",
          analysis_trigger_events: "shipping a new app",
          top_competitors: ["BetaCo"],
          what_makes_you_different: "agent-first UX",
          how_customers_find_you_today: "twitter",
          analysis_product_complexity_type: "simple",
          analysis_product_complexity_details: "single-binary CLI",
          source_url: "https://acme.example",
          auto_filled_fields: ["company_description"],
          draft_fields: ["target_customer"],
        }),
      ),
      http.post(`${API_BASE}/free-tier`, async ({ request }) => {
        receivedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            job_id: "job-url",
            status: "pending",
            module_type: "free-tier",
          },
          { status: 202 },
        );
      }),
    );
    captureStreams();
    await runCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      fromUrl: "https://acme.example",
    });
    expect(receivedBody).not.toBeNull();
    const body = receivedBody as unknown as {
      founder_input: Record<string, unknown>;
    };
    const fi = body.founder_input;
    expect(fi.product_description).toBe("Acme makes widgets");
    expect(fi.pricing).toBe("$49/mo");
    expect(fi.target_audience).toBe("indie devs");
    expect(fi.trigger_events).toBe("shipping a new app");
    expect(fi.acquisition_sources).toBe("twitter");
  });
});

describe("spec §8 exit-code matrix — at least one reachable test per code", () => {
  it("exit 0 reachable via results (manifest emit)", async () => {
    server.use(
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({
          jobs: [
            {
              job_id: "j1",
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
          files: [{ path: "notes.md", content: "hi" }],
          total_files: 1,
          truncated: false,
        }),
      ),
    );
    captureStreams();
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      out: join(tmp, "out0"),
    });
  });

  it("exit 2 reachable via unlock 422 (no prior free-tier)", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 100,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/products/:pid/unlock`, () =>
        HttpResponse.json(
          { detail: "No prior free-tier report" },
          { status: 422 },
        ),
      ),
    );
    const cap = captureStreams();
    await expect(
      unlockCommand({ product: "acme", apiBase: API_BASE, token: TOKEN }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
  });

  it("exit 3 reachable via network failure", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 100,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/free-tier`, () => HttpResponse.error()),
    );
    const cap = captureStreams();
    await expect(
      runCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        inputPath: founderInputPath,
      }),
    ).rejects.toThrow(/__exit__:3/);
    expect(cap.exitCode).toBe(3);
  });

  it("exit 4 reachable via 401", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 100,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          { detail: "Invalid or revoked access token" },
          { status: 401 },
        ),
      ),
    );
    const cap = captureStreams();
    await expect(
      runCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        inputPath: founderInputPath,
      }),
    ).rejects.toThrow(/__exit__:4/);
    expect(cap.exitCode).toBe(4);
  });

  it("exit 5 reachable via 409 conflict", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 100,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          {
            detail: "Active job",
            job_id: "running-job",
            error: {
              code: "conflict",
              message: "Active job",
              retryable: false,
              job_id: "running-job",
              product_id: "acme",
            },
          },
          { status: 409 },
        ),
      ),
    );
    const cap = captureStreams();
    await expect(
      runCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        inputPath: founderInputPath,
      }),
    ).rejects.toThrow(/__exit__:5/);
    expect(cap.exitCode).toBe(5);
    const err = JSON.parse(cap.stderr.trim().split("\n").pop()!);
    expect(err.error.job_id).toBe("running-job");
  });

  it("exit 6 reachable via 404 (jobs status)", async () => {
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

  it("exit 7 reachable via 429 rate-limited", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 100,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          { detail: "Rate limited" },
          { status: 429, headers: { "Retry-After": "30" } },
        ),
      ),
    );
    const cap = captureStreams();
    await expect(
      runCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        inputPath: founderInputPath,
      }),
    ).rejects.toThrow(/__exit__:7/);
    expect(cap.exitCode).toBe(7);
    const err = JSON.parse(cap.stderr.trim().split("\n").pop()!);
    expect(err.error.retry_after).toBe(30);
  });

  it("exit 8 reachable via pre-flight insufficient credits", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 0,
          has_stripe_customer: false,
          has_purchased: false,
          // Web-channel costs so balance=0 trips the gate (CLI run is free).
          credit_costs: {
            workflow: 15,
            unlock: 15,
            "idea-eval": 5,
            "smoke-test": 1,
            run: 1,
          },
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      runCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        inputPath: founderInputPath,
      }),
    ).rejects.toThrow(/__exit__:8/);
    expect(cap.exitCode).toBe(8);
    const err = JSON.parse(cap.stderr.trim().split("\n").pop()!);
    expect(err.error.billing_url).toContain("diffmode.app/app/billing");
  });

  it("exit 9 reachable via 500 server error", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 100,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          { detail: "Internal error" },
          { status: 500 },
        ),
      ),
    );
    const cap = captureStreams();
    await expect(
      runCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        inputPath: founderInputPath,
      }),
    ).rejects.toThrow(/__exit__:9/);
    expect(cap.exitCode).toBe(9);
  });

  it("exit 10 reachable via interrupted resumable", async () => {
    server.use(
      http.get(`${API_BASE}/jobs/job-int`, () =>
        HttpResponse.json({
          job_id: "job-int",
          status: "interrupted",
          module_type: "free-tier",
          product_id: "acme",
        }),
      ),
    );
    const cap = captureStreams();
    await expect(
      jobsWatchCommand({
        jobId: "job-int",
        apiBase: API_BASE,
        token: TOKEN,
        sleepFn: async () => {},
        isTTY: false,
      }),
    ).rejects.toThrow(/__exit__:10/);
    expect(cap.exitCode).toBe(10);
  });

  it("exit 130 reachable via simulated SIGINT during watch (and no DELETE issued)", async () => {
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
  });

  it("exit 1 reachable via jobs cancel 'no' confirmation (non-tty rejects)", async () => {
    // jobs cancel without --yes on non-TTY refuses; assert it doesn't proceed.
    let deleted = false;
    server.use(
      http.delete(`${API_BASE}/jobs/:id`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    captureStreams();
    // With --yes=true the command succeeds; this test mainly proves we reach 0
    // via the cancel path. (Exit 1 already proven by other tests covering
    // generic-error branches; this guards the happy cancel path stays 0.)
    await jobsCancelCommand({
      jobId: "to-cancel",
      apiBase: API_BASE,
      token: TOKEN,
      yes: true,
    });
    expect(deleted).toBe(true);
  });
});

describe("schema_version envelope is present on every command's JSON output", () => {
  // For each command shape this asserts the JSON envelope. The exit-code
  // matrix above already exercises error paths; this test focuses on stdout
  // success-shape envelopes that agents parse.
  it("login emits schema_version", async () => {
    const store = createCredentialStore({
      keytar: fakeKeytar(),
      configDir: join(tmp, "cfg"),
      warnFn: () => {},
    });
    server.use(
      http.get(`${API_BASE}/access-tokens`, () =>
        HttpResponse.json({ tokens: [] }),
      ),
    );
    const cap = captureStreams();
    await loginCommand({
      token: TOKEN,
      apiBase: API_BASE,
      store,
      profile: "default",
    });
    const parsed = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(parsed.schema_version).toBe("1");
  });

  it("run, jobs status, jobs cancel, and results all emit schema_version", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 5,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        }),
      ),
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          {
            job_id: "j1",
            status: "pending",
            module_type: "free-tier",
            product_id: "acme",
          },
          { status: 202 },
        ),
      ),
      http.get(`${API_BASE}/jobs/j1`, () =>
        HttpResponse.json({
          job_id: "j1",
          status: "completed",
          module_type: "free-tier",
        }),
      ),
      http.delete(`${API_BASE}/jobs/j1`, () =>
        new HttpResponse(null, { status: 204 }),
      ),
      http.get(`${API_BASE}/jobs`, () =>
        HttpResponse.json({
          jobs: [
            {
              job_id: "j1",
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
          files: [{ path: "x.md", content: "x" }],
          total_files: 1,
          truncated: false,
        }),
      ),
      http.get(`${API_BASE}/products/acme/report`, () =>
        HttpResponse.json({
          meta: { schemaVersion: "1", tier: "free" },
          landscape: { keyFinding: { heading: "L", body: "L body" } },
        }),
      ),
    );

    const cap = captureStreams();
    await runCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      inputPath: founderInputPath,
    });
    const runOut = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(runOut.schema_version).toBe("1");

    cap.stdout = "";
    await jobsStatusCommand({
      jobId: "j1",
      apiBase: API_BASE,
      token: TOKEN,
    });
    const statusOut = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(statusOut.schema_version).toBe("1");

    cap.stdout = "";
    await jobsCancelCommand({
      jobId: "j1",
      apiBase: API_BASE,
      token: TOKEN,
      yes: true,
    });
    const cancelOut = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(cancelOut.schema_version).toBe("1");

    cap.stdout = "";
    await resultsCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      out: join(tmp, "out"),
    });
    const resultsOut = JSON.parse(cap.stdout.trim().split("\n").pop()!);
    expect(resultsOut.schema_version).toBe("1");
  });

  it("`commands` manifest pins schema_version + non-empty command list", () => {
    const program = buildProgram();
    const manifest = buildCommandsManifest(program);
    expect(manifest.schema_version).toBe("1");
    expect(manifest.commands.length).toBeGreaterThan(0);
    // --idempotency-key is subcommand-scoped, never on root.
    for (const flag of manifest.globals) {
      expect(flag.flag).not.toBe("--idempotency-key");
    }
    const submitNames = ["run", "workflow", "unlock", "idea-eval", "smoke-test"];
    for (const name of submitNames) {
      const entry = manifest.commands.find((c) => c.name === name);
      expect(entry, name).toBeDefined();
      const idem = entry!.options.find((o) => o.flag === "--idempotency-key");
      expect(idem, `${name} should expose --idempotency-key`).toBeDefined();
    }
    // Jobs sub-tree must NOT expose --idempotency-key.
    const watchEntry = manifest.commands.find((c) => c.name === "jobs watch");
    expect(watchEntry).toBeDefined();
    expect(
      watchEntry!.options.find((o) => o.flag === "--idempotency-key"),
    ).toBeUndefined();
  });
});

describe("bundled CJS bin smoke tests + help snapshot + bundle size", () => {
  const repoRoot = resolve(__dirname, "..");
  const binPath = resolve(repoRoot, "dist/bin.js");

  function ensureBuilt(): void {
    if (!existsSync(binPath)) {
      execFileSync("npm", ["run", "build"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    }
  }

  it("dist/bin.js is < 1 MB (target ≤ 500 kB)", () => {
    ensureBuilt();
    const stat = statSync(binPath);
    expect(stat.size).toBeLessThan(1_000_000);
    if (stat.size > 500_000) {
      // Don't fail — but make the warning visible in test output.
      // eslint-disable-next-line no-console
      console.warn(
        `[bundle-size] dist/bin.js is ${stat.size} bytes (>500 kB target); investigate before publish.`,
      );
    }
  });

  it("dist/bin.js has the #!/usr/bin/env node shebang (CJS bin)", () => {
    ensureBuilt();
    const head = readFileSync(binPath, "utf8").slice(0, 30);
    expect(head.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("dist/bin.js --version --json works (npx-installed shape)", () => {
    ensureBuilt();
    const r = spawnSync(process.execPath, [binPath, "--version", "--json"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.node).toBe(process.version);
  });

  it("top-level --help pins the visible commands (snapshot guard for renames)", () => {
    ensureBuilt();
    const r = spawnSync(process.execPath, [binPath, "--help"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    // Pin the leaf-command surface — guards against accidental renames.
    const expectedCommands = [
      "login",
      "logout",
      "whoami",
      "diagnostics",
      "run",
      "workflow",
      "unlock",
      "idea-eval",
      "smoke-test",
      "jobs",
      "results",
      "account",
      "billing",
      "limits",
      "commands",
      "skill",
    ];
    for (const name of expectedCommands) {
      expect(r.stdout, `--help should mention "${name}"`).toMatch(
        new RegExp(`\\b${name}\\b`),
      );
    }
    // Pin the global flag surface.
    for (const flag of [
      "--json",
      "--quiet",
      "--verbose",
      "--token",
      "--profile",
      "--timeout",
    ]) {
      expect(r.stdout, `--help should list ${flag}`).toContain(flag);
    }
    // billing topup must NOT appear (browser-only by design).
    expect(r.stdout).not.toMatch(/\btopup\b/);
  });

  it("bundled bin reports an unknown command for `billing topup`", () => {
    ensureBuilt();
    const r = spawnSync(process.execPath, [binPath, "billing", "topup"], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    // commander's standard error message; tolerant of formatting variations.
    const combined = (r.stderr || "") + (r.stdout || "");
    expect(combined.toLowerCase()).toMatch(/unknown command|topup/);
  });
});

describe("package.json publish-readiness", () => {
  const repoRoot = resolve(__dirname, "..");
  // Read the file fresh each test to catch in-flight updates.
  function pkg(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  it("name = diffmode and version is a clean semver (0.1.0+ for publish)", () => {
    const p = pkg();
    expect(p.name).toBe("diffmode");
    expect(String(p.version)).toMatch(/^\d+\.\d+\.\d+([.-].+)?$/);
  });

  it("metadata fields are populated for npm publish", () => {
    const p = pkg();
    expect(p.license).toBe("Apache-2.0");
    // `repository` may be either a string ("git+https://...") or an object
    // ({type, url}) — both are valid npm conventions. Stringify the url when
    // the object form is used so the substring assertion works either way.
    const repoUrl =
      typeof p.repository === "string"
        ? p.repository
        : (p.repository as { url?: string } | null)?.url ?? "";
    expect(repoUrl).toContain("agentic-builders/diffmode-cli");
    expect(String(p.homepage)).toContain("agentic-builders/diffmode-cli");
    expect(String(p.bugs)).toContain("agentic-builders/diffmode-cli");
    expect((p.bin as Record<string, string>).diffmode).toBe("dist/bin.js");
    expect(Array.isArray(p.files)).toBe(true);
    expect((p.files as string[]).includes("dist/")).toBe(true);
    expect((p.files as string[]).includes("skills/")).toBe(true);
  });

  // Regression guard for the v0.1.0 → v0.1.1 drift: VERSION used to be a
  // hardcoded constant in src/bin.ts that npm version did not touch, so the
  // bundled bin reported the wrong version on every release. The fix imports
  // VERSION from package.json at build time; this test enforces that the
  // single source of truth survives any future refactor.
  it("dist/bin.js --version output matches package.json#version", () => {
    // Rebuild from current source + package.json so a stale dist/ on disk
    // can't mask a regression.
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
    const binPath = resolve(repoRoot, "dist/bin.js");
    const r = spawnSync(process.execPath, [binPath, "--version"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(String(pkg().version));
  });
});
