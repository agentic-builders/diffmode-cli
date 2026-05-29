import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { resetOutputConfig, setOutputConfig } from "../src/lib/output";
import { runCommand } from "../src/commands/run";
import { unlockCommand } from "../src/commands/unlock";
import { workflowCommand } from "../src/commands/workflow";
import { ideaEvalCommand } from "../src/commands/idea-eval";
import { smokeTestCommand } from "../src/commands/smoke-test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_BASE = "https://api.test/public/v1";
const TOKEN = "dm_pat_submit_token_xxxxxxxxxxxxxxxx";

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

let tmp: string;
let founderInputPath: string;

beforeEach(() => {
  server.listen({ onUnhandledRequest: "error" });
  resetOutputConfig();
  setOutputConfig({ json: true });
  tmp = mkdtempSync(join(tmpdir(), "diffmode-submit-"));
  founderInputPath = join(tmp, "founder.json");
  writeFileSync(
    founderInputPath,
    JSON.stringify({ product_description: "My SaaS for indie hackers" }),
  );
  // Default-success balance mock — submit commands now pre-flight before
  // POSTing. Individual tests can override to assert the pre-flight gate.
  server.use(
    http.get(`${API_BASE}/billing/balance`, () =>
      HttpResponse.json({
        balance: 9999,
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
  );
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  vi.restoreAllMocks();
  resetOutputConfig();
  rmSync(tmp, { recursive: true, force: true });
});

describe("diffmode run (free-tier submit)", () => {
  it("POSTs /free-tier with founder_input and prints job_id on 202", async () => {
    let receivedBody: any = null;
    server.use(
      http.post(`${API_BASE}/free-tier`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json(
          {
            job_id: "job-free-1",
            status: "pending",
            module_type: "free-tier",
            product_id: "acme",
          },
          { status: 202 },
        );
      }),
    );
    const cap = captureStreams();
    await runCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      inputPath: founderInputPath,
    });

    expect(receivedBody.product_id).toBe("acme");
    expect(receivedBody.founder_input.product_description).toBe(
      "My SaaS for indie hackers",
    );
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.job_id).toBe("job-free-1");
    expect(parsed.status).toBe("pending");
    expect(parsed.module_type).toBe("free-tier");
  });

  it("sends Idempotency-Key header when --idempotency-key passed", async () => {
    let idem: string | null = null;
    server.use(
      http.post(`${API_BASE}/free-tier`, ({ request }) => {
        idem = request.headers.get("idempotency-key");
        return HttpResponse.json(
          { job_id: "j1", status: "pending", module_type: "free-tier" },
          { status: 202 },
        );
      }),
    );
    captureStreams();
    await runCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      inputPath: founderInputPath,
      idempotencyKey: "11111111-1111-1111-1111-111111111111",
    });
    expect(idem).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("scopes Idempotency-Key to the terminal submit POST only", async () => {
    // Idempotency-Key is subcommand-scoped per CLAUDE.md rule 7. The header
    // must not leak onto the preflight GET /billing/balance or the
    // /analyze-website POST that --from-url issues; only the terminal
    // /free-tier submit POST should carry it.
    const balanceIdem = vi.fn<(v: string | null) => void>();
    const analyzeIdem = vi.fn<(v: string | null) => void>();
    let submitIdem: string | null = null;
    server.use(
      http.get(`${API_BASE}/billing/balance`, ({ request }) => {
        balanceIdem(request.headers.get("idempotency-key"));
        return HttpResponse.json({
          balance: 9999,
          has_stripe_customer: true,
          has_purchased: true,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        });
      }),
      http.post(`${API_BASE}/analyze-website`, ({ request }) => {
        analyzeIdem(request.headers.get("idempotency-key"));
        return HttpResponse.json({
          company_description: "Stub product description",
          target_customer: "Stub target",
          analysis_pricing: "$0",
          auto_filled_fields: ["company_description"],
          draft_fields: [],
        });
      }),
      http.post(`${API_BASE}/free-tier`, ({ request }) => {
        submitIdem = request.headers.get("idempotency-key");
        return HttpResponse.json(
          { job_id: "j1", status: "pending", module_type: "free-tier" },
          { status: 202 },
        );
      }),
    );
    captureStreams();
    await runCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      fromUrl: "https://example.com",
      idempotencyKey: "22222222-2222-2222-2222-222222222222",
    });
    expect(balanceIdem).toHaveBeenCalledWith(null);
    expect(analyzeIdem).toHaveBeenCalledWith(null);
    expect(submitIdem).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("does NOT send Idempotency-Key header when --idempotency-key absent (no auto-gen)", async () => {
    let idem: string | null = null;
    server.use(
      http.post(`${API_BASE}/free-tier`, ({ request }) => {
        idem = request.headers.get("idempotency-key");
        return HttpResponse.json(
          { job_id: "j1", status: "pending", module_type: "free-tier" },
          { status: 202 },
        );
      }),
    );
    captureStreams();
    await runCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      inputPath: founderInputPath,
    });
    expect(idem).toBeNull();
  });

  it("maps 402 to exit 8 with billing URL", async () => {
    server.use(
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          { detail: "Insufficient credits" },
          { status: 402 },
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
    ).rejects.toThrow(/__exit__:8/);
    expect(cap.exitCode).toBe(8);
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("insufficient_credits");
    expect(err.error.billing_url).toContain("diffmode.app/app/billing");
  });

  it("server-side 402 honors DIFFMODE_BILLING_URL env override", async () => {
    server.use(
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json({ detail: "need credits" }, { status: 402 }),
      ),
    );
    const original = process.env["DIFFMODE_BILLING_URL"];
    process.env["DIFFMODE_BILLING_URL"] = "https://billing.internal.example/topup";
    const cap = captureStreams();
    try {
      await expect(
        runCommand({
          product: "acme",
          apiBase: API_BASE,
          token: TOKEN,
          inputPath: founderInputPath,
          noPreflight: true,
        }),
      ).rejects.toThrow(/__exit__:8/);
      const err = JSON.parse(cap.stderr);
      expect(err.error.billing_url).toBe(
        "https://billing.internal.example/topup?channel=cli",
      );
    } finally {
      if (original === undefined) delete process.env["DIFFMODE_BILLING_URL"];
      else process.env["DIFFMODE_BILLING_URL"] = original;
    }
  });

  it("maps 409 conflict to exit 5 with active job_id surfaced", async () => {
    server.use(
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          {
            detail: "Active job for product acme",
            job_id: "job-active",
            error: {
              code: "conflict",
              message: "Active job",
              retryable: false,
              job_id: "job-active",
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
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("conflict");
    expect(err.error.job_id).toBe("job-active");
  });

  it("maps 429 to exit 7 with retry_after surfaced", async () => {
    server.use(
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          { detail: "Rate limited" },
          { status: 429, headers: { "Retry-After": "42" } },
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
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("rate_limited");
    expect(err.error.retry_after).toBe(42);
  });
});

describe("diffmode unlock", () => {
  it("POSTs /products/{id}/unlock with empty body on success", async () => {
    let receivedBody: any = null;
    let receivedPath = "";
    server.use(
      http.post(`${API_BASE}/products/:pid/unlock`, async ({ request, params }) => {
        receivedPath = params.pid as string;
        receivedBody = await request.json();
        return HttpResponse.json(
          { job_id: "unl-1", status: "pending", module_type: "unlock" },
          { status: 202 },
        );
      }),
    );
    const cap = captureStreams();
    await unlockCommand({ product: "acme", apiBase: API_BASE, token: TOKEN });
    expect(receivedPath).toBe("acme");
    expect(receivedBody).toEqual({});
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.job_id).toBe("unl-1");
    expect(parsed.module_type).toBe("unlock");
  });

  it("translates 404 (no completed free-tier) to exit 2 with helpful `diffmode run` hint", async () => {
    // Backend returns 404 (NotFoundError) when there is no completed free-tier
    // job for the product. The CLI re-maps that into a UsageError so the
    // agent gets the documented exit 2 + actionable next step.
    server.use(
      http.post(`${API_BASE}/products/:pid/unlock`, () =>
        HttpResponse.json(
          { detail: "No completed free-tier analysis for this product" },
          { status: 404 },
        ),
      ),
    );
    const cap = captureStreams();
    await expect(
      unlockCommand({ product: "acme", apiBase: API_BASE, token: TOKEN }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("usage");
    expect(err.error.message).toMatch(/diffmode run/i);
  });

  it("passes 422 (corrupted free-tier result) through unchanged with server detail", async () => {
    // 422 from backend means a different failure mode (missing result data /
    // founder_input). We must NOT swallow the server's detail under the
    // "run free-tier first" hint — that would mislead the agent.
    server.use(
      http.post(`${API_BASE}/products/:pid/unlock`, () =>
        HttpResponse.json(
          { detail: "Free-tier job missing founder input data" },
          { status: 422 },
        ),
      ),
    );
    const cap = captureStreams();
    await expect(
      unlockCommand({ product: "acme", apiBase: API_BASE, token: TOKEN }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("usage");
    expect(err.error.message).toMatch(/Free-tier job missing founder input data/);
    expect(err.error.message).not.toMatch(/diffmode run/);
  });
});

describe("diffmode workflow", () => {
  it("POSTs /workflow with FounderDiagnostics in body", async () => {
    let receivedBody: any = null;
    server.use(
      http.post(`${API_BASE}/workflow`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json(
          { job_id: "wf-1", status: "pending", module_type: "workflow" },
          { status: 202 },
        );
      }),
    );
    const cap = captureStreams();
    await workflowCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      inputPath: founderInputPath,
    });
    expect(receivedBody.product_id).toBe("acme");
    expect(receivedBody.founder_input.product_description).toBe(
      "My SaaS for indie hackers",
    );
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.job_id).toBe("wf-1");
    expect(parsed.module_type).toBe("workflow");
  });
});

describe("diffmode idea-eval", () => {
  it("POSTs /idea-eval with structured ideas list, not strings", async () => {
    let receivedBody: any = null;
    server.use(
      http.post(`${API_BASE}/idea-eval`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json(
          { job_id: "ie-1", status: "pending", module_type: "idea-eval" },
          { status: 202 },
        );
      }),
    );
    const ideasPath = join(tmp, "ideas.json");
    writeFileSync(
      ideasPath,
      JSON.stringify([
        { name: "idea1", description: "first idea" },
        { name: "idea2", description: "second idea", target_customer: "indie devs" },
      ]),
    );
    const cap = captureStreams();
    await ideaEvalCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      ideasFile: ideasPath,
      intuition: "I think idea2 is better",
    });
    expect(receivedBody.product_id).toBe("acme");
    expect(Array.isArray(receivedBody.ideas)).toBe(true);
    expect(receivedBody.ideas).toHaveLength(2);
    expect(receivedBody.ideas[0].name).toBe("idea1");
    expect(receivedBody.ideas[0].description).toBe("first idea");
    expect(receivedBody.intuition).toBe("I think idea2 is better");
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.module_type).toBe("idea-eval");
  });

  it("rejects ideas file that is not a JSON array", async () => {
    const ideasPath = join(tmp, "ideas.json");
    writeFileSync(ideasPath, JSON.stringify({ ideas: [] }));
    const cap = captureStreams();
    await expect(
      ideaEvalCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        ideasFile: ideasPath,
      }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
  });

  it("rejects ideas list missing required `name` or `description`", async () => {
    const ideasPath = join(tmp, "ideas.json");
    writeFileSync(
      ideasPath,
      JSON.stringify([{ name: "idea1" }]), // missing description
    );
    const cap = captureStreams();
    await expect(
      ideaEvalCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        ideasFile: ideasPath,
      }),
    ).rejects.toThrow(/__exit__:2/);
    expect(cap.exitCode).toBe(2);
  });
});

describe("diffmode smoke-test", () => {
  it("ALWAYS sends founder_input (no reliance on server-disk fallback)", async () => {
    let receivedBody: any = null;
    server.use(
      http.post(`${API_BASE}/smoke-test`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json(
          { job_id: "smk-1", status: "pending", module_type: "smoke-test" },
          { status: 202 },
        );
      }),
    );
    const cap = captureStreams();
    await smokeTestCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      inputPath: founderInputPath,
    });
    expect(receivedBody.founder_input.product_description).toBe(
      "My SaaS for indie hackers",
    );
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.module_type).toBe("smoke-test");
  });
});

describe("pre-flight credit check (cross-cutting)", () => {
  it("blocks `run` when balance < 1 and never POSTs /free-tier", async () => {
    let submitCalled = false;
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        // Web-channel costs so balance=0 trips the gate (CLI run is free).
        HttpResponse.json({
          balance: 0,
          has_stripe_customer: false,
          has_purchased: false,
          credit_costs: {
            workflow: 15,
            unlock: 15,
            "idea-eval": 5,
            "smoke-test": 1,
            run: 1,
          },
        }),
      ),
      http.post(`${API_BASE}/free-tier`, () => {
        submitCalled = true;
        return HttpResponse.json({ job_id: "x", status: "pending" }, { status: 202 });
      }),
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
    expect(submitCalled).toBe(false);
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("insufficient_credits");
    expect(err.error.billing_url).toContain("diffmode.app/app/billing");
    expect(err.error.message).toMatch(/need 1/);
    expect(err.error.message).toMatch(/have 0/);
  });

  it("blocks `unlock` when balance < 15 and never POSTs unlock", async () => {
    let submitCalled = false;
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        // Web-channel unlock cost (15) so balance=10 trips the gate.
        HttpResponse.json({
          balance: 10,
          has_stripe_customer: false,
          has_purchased: false,
          credit_costs: {
            workflow: 15,
            unlock: 15,
            "idea-eval": 5,
            "smoke-test": 1,
            run: 1,
          },
        }),
      ),
      http.post(`${API_BASE}/products/:pid/unlock`, () => {
        submitCalled = true;
        return HttpResponse.json({ job_id: "x", status: "pending" }, { status: 202 });
      }),
    );
    const cap = captureStreams();
    await expect(
      unlockCommand({ product: "acme", apiBase: API_BASE, token: TOKEN }),
    ).rejects.toThrow(/__exit__:8/);
    expect(cap.exitCode).toBe(8);
    expect(submitCalled).toBe(false);
  });

  it("blocks `idea-eval` when balance < 5 and never POSTs idea-eval", async () => {
    let submitCalled = false;
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        // Web-channel idea-eval cost (5) so balance=2 trips the gate.
        HttpResponse.json({
          balance: 2,
          has_stripe_customer: false,
          has_purchased: false,
          credit_costs: {
            workflow: 15,
            unlock: 15,
            "idea-eval": 5,
            "smoke-test": 1,
            run: 1,
          },
        }),
      ),
      http.post(`${API_BASE}/idea-eval`, () => {
        submitCalled = true;
        return HttpResponse.json({ job_id: "x", status: "pending" }, { status: 202 });
      }),
    );
    const ideasPath = join(tmp, "ideas.json");
    writeFileSync(
      ideasPath,
      JSON.stringify([{ name: "i1", description: "d1" }]),
    );
    const cap = captureStreams();
    await expect(
      ideaEvalCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        ideasFile: ideasPath,
      }),
    ).rejects.toThrow(/__exit__:8/);
    expect(cap.exitCode).toBe(8);
    expect(submitCalled).toBe(false);
  });

  it("`--no-preflight` (noPreflight=true) skips the gate and submits", async () => {
    let balanceCalled = false;
    let submitCalled = false;
    server.use(
      http.get(`${API_BASE}/billing/balance`, () => {
        balanceCalled = true;
        return HttpResponse.json({
          balance: 0,
          has_stripe_customer: false,
          has_purchased: false,
          credit_costs: {
            workflow: 2,
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        });
      }),
      http.post(`${API_BASE}/free-tier`, () => {
        submitCalled = true;
        return HttpResponse.json(
          { job_id: "j1", status: "pending", module_type: "free-tier" },
          { status: 202 },
        );
      }),
    );
    captureStreams();
    await runCommand({
      product: "acme",
      apiBase: API_BASE,
      token: TOKEN,
      inputPath: founderInputPath,
      noPreflight: true,
    });
    expect(balanceCalled).toBe(false);
    expect(submitCalled).toBe(true);
  });

  it("402 from server (race window) still produces exit 8 + billing URL", async () => {
    // Pre-flight passes (default 9999 balance), but the server then 402s
    // on the actual submit — simulates the credit-was-spent-between-calls race.
    server.use(
      http.post(`${API_BASE}/free-tier`, () =>
        HttpResponse.json(
          { detail: "Insufficient credits (server-side)" },
          { status: 402 },
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
    ).rejects.toThrow(/__exit__:8/);
    expect(cap.exitCode).toBe(8);
    const err = JSON.parse(cap.stderr);
    expect(err.error.code).toBe("insufficient_credits");
    expect(err.error.billing_url).toContain("diffmode.app/app/billing");
  });

  it("CLI never invokes POST /billing/checkout on insufficient credits", async () => {
    let checkoutCalled = false;
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        // Web-channel costs so balance=0 trips the gate (CLI run is free).
        HttpResponse.json({
          balance: 0,
          has_stripe_customer: false,
          has_purchased: false,
          credit_costs: {
            workflow: 15,
            unlock: 15,
            "idea-eval": 5,
            "smoke-test": 1,
            run: 1,
          },
        }),
      ),
      http.post(`${API_BASE}/billing/checkout`, () => {
        checkoutCalled = true;
        return HttpResponse.json({ url: "https://checkout.stripe.com/x" });
      }),
    );
    captureStreams();
    await expect(
      runCommand({
        product: "acme",
        apiBase: API_BASE,
        token: TOKEN,
        inputPath: founderInputPath,
      }),
    ).rejects.toThrow(/__exit__:8/);
    expect(checkoutCalled).toBe(false);
  });
});
