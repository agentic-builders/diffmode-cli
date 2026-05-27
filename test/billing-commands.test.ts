import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { resetOutputConfig, setOutputConfig } from "../src/lib/output";
import { accountCommand } from "../src/commands/account";
import { billingBalanceCommand } from "../src/commands/billing/balance";
import { billingHistoryCommand } from "../src/commands/billing/history";
import { limitsCommand } from "../src/commands/limits";

const API_BASE = "https://api.test/public/v1";
const TOKEN = "dm_pat_billing_token_xxxxxxxxxxxxxxxx";

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
const ORIGINAL_BILLING_URL = process.env["DIFFMODE_BILLING_URL"];

beforeEach(() => {
  server.listen({ onUnhandledRequest: "error" });
  resetOutputConfig();
  setOutputConfig({ json: true });
  delete process.env["DIFFMODE_BILLING_URL"];
});

afterEach(() => {
  server.resetHandlers();
  server.close();
  vi.restoreAllMocks();
  resetOutputConfig();
  if (ORIGINAL_BILLING_URL === undefined) {
    delete process.env["DIFFMODE_BILLING_URL"];
  } else {
    process.env["DIFFMODE_BILLING_URL"] = ORIGINAL_BILLING_URL;
  }
});

describe("diffmode account", () => {
  it("GETs /billing/balance and prints full CreditBalance JSON shape", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 42,
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
    const cap = captureStreams();
    await accountCommand({ apiBase: API_BASE, token: TOKEN });
    const parsed = JSON.parse(cap.stdout.trim());
    expect(parsed.schema_version).toBe("1");
    expect(parsed.balance).toBe(42);
    expect(parsed.has_stripe_customer).toBe(true);
    expect(parsed.has_purchased).toBe(true);
  });

  it("on 401 exits 4 with auth error", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({ detail: "Invalid token" }, { status: 401 }),
      ),
    );
    const cap = captureStreams();
    await expect(
      accountCommand({ apiBase: API_BASE, token: TOKEN }),
    ).rejects.toThrow(/__exit__:4/);
    expect(cap.exitCode).toBe(4);
    const err = JSON.parse(cap.stderr.trim());
    expect(err.error.code).toBe("auth");
  });
});

describe("diffmode billing balance", () => {
  it("emits a terse {balance, has_purchased} object", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 7,
          has_stripe_customer: false,
          has_purchased: false,
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
    const cap = captureStreams();
    await billingBalanceCommand({ apiBase: API_BASE, token: TOKEN });
    const parsed = JSON.parse(cap.stdout.trim());
    expect(parsed.schema_version).toBe("1");
    expect(parsed.balance).toBe(7);
    expect(parsed.has_purchased).toBe(false);
    // Terse: don't leak has_stripe_customer (an internal flag).
    expect(parsed.has_stripe_customer).toBeUndefined();
  });
});

describe("diffmode billing history", () => {
  function fakeTx(id: string, amount: number): Record<string, unknown> {
    return {
      id,
      amount,
      type: amount > 0 ? "purchase" : "reservation",
      reason: null,
      job_id: null,
      stripe_id: null,
      balance_after: 100,
      created_at: "2026-05-20T00:00:00Z",
    };
  }

  it("emits NDJSON, one transaction per line", async () => {
    server.use(
      http.get(`${API_BASE}/billing/history`, () =>
        HttpResponse.json({
          transactions: [fakeTx("t1", 50), fakeTx("t2", -1)],
          total: 2,
          has_more: false,
        }),
      ),
    );
    const cap = captureStreams();
    await billingHistoryCommand({ apiBase: API_BASE, token: TOKEN });
    const lines = cap.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    const t1 = JSON.parse(lines[0]!);
    const t2 = JSON.parse(lines[1]!);
    expect(t1.id).toBe("t1");
    expect(t2.id).toBe("t2");
  });

  it("forwards limit + offset as query params (offset-based, NOT B5 keyset)", async () => {
    let receivedLimit: string | null = null;
    let receivedOffset: string | null = null;
    let receivedCursor: string | null = "should-stay-null";
    server.use(
      http.get(`${API_BASE}/billing/history`, ({ request }) => {
        const url = new URL(request.url);
        receivedLimit = url.searchParams.get("limit");
        receivedOffset = url.searchParams.get("offset");
        receivedCursor = url.searchParams.get("cursor");
        return HttpResponse.json({
          transactions: [],
          total: 0,
          has_more: false,
        });
      }),
    );
    captureStreams();
    await billingHistoryCommand({
      apiBase: API_BASE,
      token: TOKEN,
      limit: 25,
      offset: 50,
    });
    expect(receivedLimit).toBe("25");
    expect(receivedOffset).toBe("50");
    expect(receivedCursor).toBeNull();
  });

  it("appends a final {has_more,next_offset} record when has_more=true", async () => {
    server.use(
      http.get(`${API_BASE}/billing/history`, () =>
        HttpResponse.json({
          transactions: [fakeTx("t1", 10), fakeTx("t2", -1)],
          total: 100,
          has_more: true,
        }),
      ),
    );
    const cap = captureStreams();
    await billingHistoryCommand({
      apiBase: API_BASE,
      token: TOKEN,
      limit: 2,
      offset: 0,
    });
    const lines = cap.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    const final = JSON.parse(lines[2]!);
    expect(final.has_more).toBe(true);
    expect(final.next_offset).toBe(2);
  });
});

describe("diffmode limits", () => {
  it("derives credits + documents rate-limit policy", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 4,
          has_stripe_customer: false,
          has_purchased: false,
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
    const cap = captureStreams();
    await limitsCommand({ apiBase: API_BASE, token: TOKEN });
    const parsed = JSON.parse(cap.stdout.trim());
    expect(parsed.schema_version).toBe("1");
    expect(parsed.credits_available).toBe(4);
    expect(parsed.has_purchased).toBe(false);
    expect(parsed.rate_limit_window_h).toBe(24);
    expect(parsed.rate_limit_max).toBe(3);
    expect(parsed.billing_url).toBe("https://diffmode.app/app/billing");
    // Plan: does NOT estimate free_submits_remaining
    expect(parsed.free_submits_remaining).toBeUndefined();
    // Channel-aware credit costs surfaced verbatim from /billing/balance.
    expect(parsed.credit_costs).toEqual({
      workflow: 2,
      unlock: 2,
      "idea-eval": 1,
      "smoke-test": 1,
      run: 0,
    });
  });

  it("respects DIFFMODE_BILLING_URL env override", async () => {
    process.env["DIFFMODE_BILLING_URL"] = "https://staging.diffmode.app/app/billing";
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
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
        }),
      ),
    );
    const cap = captureStreams();
    await limitsCommand({ apiBase: API_BASE, token: TOKEN });
    const parsed = JSON.parse(cap.stdout.trim());
    expect(parsed.billing_url).toBe("https://staging.diffmode.app/app/billing");
  });
});
