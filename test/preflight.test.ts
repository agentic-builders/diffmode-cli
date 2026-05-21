import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { HttpClient } from "../src/lib/http";
import { preflightCredits, MODULE_CREDIT_COSTS } from "../src/lib/preflight";
import { InsufficientCreditsError } from "../src/lib/errors";

const API_BASE = "https://api.test/public/v1";

const server = setupServer();
beforeEach(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  server.close();
});

function buildClient(): HttpClient {
  return new HttpClient({ baseUrl: API_BASE, token: "dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx" });
}

describe("MODULE_CREDIT_COSTS", () => {
  it("matches the spec/plan costs", () => {
    expect(MODULE_CREDIT_COSTS["run"]).toBe(1);
    expect(MODULE_CREDIT_COSTS["smoke-test"]).toBe(1);
    expect(MODULE_CREDIT_COSTS["idea-eval"]).toBe(5);
    expect(MODULE_CREDIT_COSTS["unlock"]).toBe(15);
    expect(MODULE_CREDIT_COSTS["workflow"]).toBe(15);
  });
});

describe("preflightCredits", () => {
  it("returns the balance when enough credits are available", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 50,
          has_stripe_customer: true,
          has_purchased: true,
        }),
      ),
    );
    const result = await preflightCredits({
      client: buildClient(),
      required: 15,
      billingUrl: "https://diffmode.app/app/billing",
    });
    expect(result.balance).toBe(50);
    expect(result.required).toBe(15);
  });

  it("throws InsufficientCreditsError when balance < required", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 2,
          has_stripe_customer: false,
          has_purchased: false,
        }),
      ),
    );
    await expect(
      preflightCredits({
        client: buildClient(),
        required: 15,
        billingUrl: "https://diffmode.app/app/billing",
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it("error message includes required + have + billing URL", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 3,
          has_stripe_customer: false,
          has_purchased: false,
        }),
      ),
    );
    try {
      await preflightCredits({
        client: buildClient(),
        required: 15,
        billingUrl: "https://staging.diffmode.app/app/billing",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientCreditsError);
      const e = err as InsufficientCreditsError;
      expect(e.message).toMatch(/need 15/);
      expect(e.message).toMatch(/have 3/);
      expect(e.message).toMatch(/staging\.diffmode\.app\/app\/billing/);
      expect(e.billing_url).toBe("https://staging.diffmode.app/app/billing");
    }
  });

  it("passes balance fetch errors through (does not swallow 401)", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({ detail: "Invalid token" }, { status: 401 }),
      ),
    );
    await expect(
      preflightCredits({
        client: buildClient(),
        required: 1,
        billingUrl: "https://diffmode.app/app/billing",
      }),
    ).rejects.toMatchObject({ code: "auth" });
  });
});
