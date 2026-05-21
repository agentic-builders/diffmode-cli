import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  HttpClient,
  DEFAULT_API_BASE,
  DEFAULT_BILLING_URL,
} from "../src/lib/http";
import {
  AuthError,
  ConflictError,
  InsufficientCreditsError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  ServerError,
  UsageError,
} from "../src/lib/errors";

interface MockResponseInit {
  status: number;
  body?: any;
  headers?: Record<string, string>;
  textBody?: string;
}

function mockResponse(init: MockResponseInit): Response {
  const headers = new Headers(init.headers ?? {});
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const text =
    init.textBody !== undefined
      ? init.textBody
      : init.body !== undefined
        ? JSON.stringify(init.body)
        : "";
  return new Response(text, { status: init.status, headers });
}

describe("HttpClient — Authorization header", () => {
  it("injects Authorization: Bearer <token>", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return mockResponse({ status: 200, body: { ok: true } });
    });
    const c = new HttpClient({
      baseUrl: "https://api.test/public/v1",
      token: "dm_pat_test_token_aaaaaaaaaaaaaaa",
      fetchFn,
    });
    await c.get("/access-tokens");
    expect(calls).toHaveLength(1);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      "Bearer dm_pat_test_token_aaaaaaaaaaaaaaa",
    );
  });

  it("does NOT send Authorization when token is null/absent", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return mockResponse({ status: 200, body: { ok: true } });
    });
    const c = new HttpClient({ baseUrl: "https://api.test/public/v1", fetchFn });
    await c.get("/access-tokens");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("redacts Authorization header from verbose log output", async () => {
    const lines: string[] = [];
    const fetchFn = vi.fn(async () =>
      mockResponse({ status: 200, body: { ok: true } }),
    );
    const c = new HttpClient({
      baseUrl: "https://api.test/public/v1",
      token: "dm_pat_super_secret_should_never_leak",
      fetchFn,
      verbose: true,
      verboseLog: (s) => lines.push(s),
    });
    await c.get("/access-tokens");
    const joined = lines.join("\n");
    expect(joined).not.toContain("dm_pat_super_secret_should_never_leak");
    expect(joined).toMatch(/Bearer \*\*\*/);
  });
});

describe("HttpClient — status code → error mapping", () => {
  function makeClient(response: MockResponseInit) {
    const fetchFn = vi.fn(async () => mockResponse(response));
    return new HttpClient({
      baseUrl: "https://api.test/public/v1",
      token: "dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
      fetchFn,
    });
  }

  it("401 → AuthError (exit 4) with helpful login hint", async () => {
    const c = makeClient({
      status: 401,
      body: { detail: "Invalid or revoked access token" },
    });
    await expect(c.get("/access-tokens")).rejects.toMatchObject({
      exitCode: 4,
      code: "auth",
    });
    await expect(c.get("/access-tokens")).rejects.toBeInstanceOf(AuthError);
  });

  it("402 → InsufficientCreditsError (exit 8) with default billing URL", async () => {
    const c = makeClient({
      status: 402,
      body: {
        detail: "Insufficient credits: need 15, have 0",
        error: { code: "insufficient_credits", message: "..." },
      },
    });
    let thrown: any;
    try {
      await c.post("/products/p/unlock", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InsufficientCreditsError);
    expect(thrown.exitCode).toBe(8);
    expect(thrown.billing_url).toBe(DEFAULT_BILLING_URL);
  });

  it("402 → InsufficientCreditsError uses configured billingUrl override", async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ status: 402, body: { detail: "need credits" } }),
    );
    const c = new HttpClient({
      baseUrl: "https://api.test/public/v1",
      token: "dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
      billingUrl: "https://example.com/topup",
      fetchFn,
    });
    let thrown: any;
    try {
      await c.post("/products/p/unlock", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown.billing_url).toBe("https://example.com/topup");
  });

  it("402 must NOT read `checkout_url` from response body (CLI is read-only for billing)", async () => {
    const c = makeClient({
      status: 402,
      body: {
        detail: "need credits",
        checkout_url: "https://stripe.example/checkout/abc",
      },
    });
    let thrown: any;
    try {
      await c.post("/products/p/unlock", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown.billing_url).toBe(DEFAULT_BILLING_URL);
    expect(thrown.billing_url).not.toContain("stripe.example");
  });

  it("409 → ConflictError carrying error.job_id", async () => {
    const c = makeClient({
      status: 409,
      body: {
        detail: "A free-tier job is already running for product 'p' (job j-9)",
        job_id: "j-9",
        error: {
          code: "conflict",
          message: "already running",
          retryable: false,
          job_id: "j-9",
          product_id: "p",
        },
      },
    });
    let thrown: any;
    try {
      await c.post("/free-tier", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictError);
    expect(thrown.exitCode).toBe(5);
    expect(thrown.job_id).toBe("j-9");
    expect(thrown.product_id).toBe("p");
  });

  it("422 → UsageError (exit 2) preserving server detail", async () => {
    const c = makeClient({
      status: 422,
      body: {
        detail:
          "Cannot unlock — no prior free-tier completion for this product",
      },
    });
    let thrown: any;
    try {
      await c.post("/products/p/unlock", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(thrown.exitCode).toBe(2);
    expect(thrown.message).toContain(
      "no prior free-tier completion",
    );
  });

  it("422 → UsageError formats FastAPI's detail array (no [object Object])", async () => {
    // FastAPI returns Pydantic validation errors as a structured array.
    // Before this fix the CLI rendered the array as "[object Object]" via
    // template-string coercion.
    const c = makeClient({
      status: 422,
      body: {
        detail: [
          {
            type: "model_attributes_type",
            loc: ["body", "founder_input", "current_growth"],
            msg: "Input should be a valid dictionary or object to extract fields from",
            input: "Word of mouth + cold email",
          },
        ],
      },
    });
    let thrown: any;
    try {
      await c.post("/smoke-test", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(thrown.exitCode).toBe(2);
    expect(thrown.message).not.toContain("[object Object]");
    expect(thrown.message).toContain("founder_input.current_growth");
    expect(thrown.message).toContain("valid dictionary");
  });

  it("422 → UsageError joins multiple FastAPI validation errors", async () => {
    const c = makeClient({
      status: 422,
      body: {
        detail: [
          {
            loc: ["body", "founder_input", "current_growth"],
            msg: "Input should be a valid dictionary",
          },
          {
            loc: ["body", "founder_input", "challenges"],
            msg: "Input should be a valid dictionary",
          },
        ],
      },
    });
    let thrown: any;
    try {
      await c.post("/smoke-test", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    expect(thrown.message).toContain("current_growth");
    expect(thrown.message).toContain("challenges");
    expect(thrown.message).not.toContain("[object Object]");
  });

  it("429 → RateLimitedError reads Retry-After header", async () => {
    const c = makeClient({
      status: 429,
      body: { detail: "Rate limit exceeded" },
      headers: { "Retry-After": "120" },
    });
    let thrown: any;
    try {
      await c.post("/free-tier", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(thrown.exitCode).toBe(7);
    expect(thrown.retry_after).toBe(120);
  });

  it("429 → RateLimitedError falls back to error.retry_after when header absent", async () => {
    const c = makeClient({
      status: 429,
      body: {
        detail: "Rate limit exceeded",
        error: {
          code: "rate_limited",
          message: "Rate limit exceeded",
          retryable: true,
          retry_after: 60,
        },
      },
    });
    let thrown: any;
    try {
      await c.post("/free-tier", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown.retry_after).toBe(60);
  });

  it("404 → NotFoundError (exit 6)", async () => {
    const c = makeClient({
      status: 404,
      body: { detail: "Job not found" },
    });
    await expect(c.get("/jobs/abc")).rejects.toBeInstanceOf(NotFoundError);
    await expect(c.get("/jobs/abc")).rejects.toMatchObject({ exitCode: 6 });
  });

  it("500 → ServerError (exit 9), retryable when error.retryable=true", async () => {
    const c = makeClient({
      status: 500,
      body: {
        detail: "internal",
        error: { code: "server", message: "internal", retryable: true },
      },
    });
    let thrown: any;
    try {
      await c.get("/jobs/abc");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ServerError);
    expect(thrown.exitCode).toBe(9);
    expect(thrown.retryable).toBe(true);
  });

  it("500 → ServerError defaults retryable=true when envelope absent", async () => {
    const c = makeClient({
      status: 503,
      textBody: "Bad Gateway",
      headers: { "content-type": "text/html" },
    });
    let thrown: any;
    try {
      await c.get("/jobs/abc");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ServerError);
    expect(thrown.retryable).toBe(true);
  });

  it("JSON parse failure on response → NetworkError (exit 3) with body excerpt", async () => {
    const c = makeClient({
      status: 200,
      textBody: "<html>not json</html>",
      headers: { "content-type": "application/json" },
    });
    let thrown: any;
    try {
      await c.get("/jobs/abc");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
    expect(thrown.exitCode).toBe(3);
    expect(thrown.message).toMatch(/<html>not json/);
  });
});

describe("HttpClient — timeout + network errors", () => {
  it("aborts after timeoutMs (per-HTTP-request timeout)", async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          if (sig) {
            sig.addEventListener("abort", () => {
              const e: any = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          }
        }),
    );
    const c = new HttpClient({
      baseUrl: "https://api.test/public/v1",
      token: "dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
      fetchFn,
      timeoutMs: 25,
    });
    let thrown: any;
    try {
      await c.get("/access-tokens");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NetworkError);
    expect(thrown.exitCode).toBe(3);
    expect(thrown.message).toMatch(/timed? ?out|aborted/i);
  });

  it("fetch rejection → NetworkError", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const c = new HttpClient({
      baseUrl: "https://api.test/public/v1",
      token: "dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
      fetchFn,
    });
    await expect(c.get("/whatever")).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("HttpClient — success response parsing", () => {
  it("returns parsed JSON on 200", async () => {
    const fetchFn = vi.fn(async () =>
      mockResponse({ status: 200, body: { tokens: [] } }),
    );
    const c = new HttpClient({
      baseUrl: "https://api.test/public/v1",
      token: "dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
      fetchFn,
    });
    const r = await c.get<{ tokens: unknown[] }>("/access-tokens");
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ tokens: [] });
  });

  it("handles 204 No Content (no body to parse)", async () => {
    const fetchFn = vi.fn(
      async () => new Response(null, { status: 204 }),
    );
    const c = new HttpClient({
      baseUrl: "https://api.test/public/v1",
      token: "dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
      fetchFn,
    });
    const r = await c.delete("/jobs/abc");
    expect(r.status).toBe(204);
    expect(r.data).toBeNull();
  });

  it("joins baseUrl and path correctly (no double slash)", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url);
      return mockResponse({ status: 200, body: {} });
    });
    const c = new HttpClient({
      baseUrl: "https://api.test/public/v1/",
      fetchFn,
    });
    await c.get("/access-tokens");
    expect(urls[0]).toBe("https://api.test/public/v1/access-tokens");
  });

  it("DEFAULT_API_BASE is the production /public/v1 URL", () => {
    expect(DEFAULT_API_BASE).toBe(
      "https://ai-cmo-api.onrender.com/public/v1",
    );
  });

  it("DEFAULT_BILLING_URL is the diffmode.app billing page", () => {
    expect(DEFAULT_BILLING_URL).toBe("https://diffmode.app/app/billing");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  // no-op; placeholder for future shared setup
});
