import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { HttpClient } from "../src/lib/http";
import { preflightCredits } from "../src/lib/preflight";
import type { CreditBalancePayload } from "../src/lib/preflight";
import {
  InsufficientCreditsError,
  PricingUnavailableError,
} from "../src/lib/errors";

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

describe("preflightCredits", () => {
  it("returns the balance when enough credits are available", async () => {
    server.use(
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
    );
    const result = await preflightCredits({
      client: buildClient(),
      action: "workflow",
      billingUrl: "https://diffmode.app/app/billing",
    });
    expect(result.balance).toBe(50);
    expect(result.required).toBe(2);
  });

  it("throws InsufficientCreditsError when balance < server-resolved cost", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 1,
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
    );
    await expect(
      preflightCredits({
        client: buildClient(),
        action: "workflow",
        billingUrl: "https://diffmode.app/app/billing",
      }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it("error message includes server-resolved cost + have + billing URL", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 3,
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
    );
    try {
      await preflightCredits({
        client: buildClient(),
        action: "workflow",
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
        action: "run",
        billingUrl: "https://diffmode.app/app/billing",
      }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  it("throws PricingUnavailableError when response is missing credit_costs", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        // Old backend that doesn't return credit_costs — cast bypasses the
        // compile-time type so we can simulate runtime drift.
        HttpResponse.json({
          balance: 50,
          has_stripe_customer: true,
          has_purchased: true,
        } as unknown as CreditBalancePayload),
      ),
    );
    await expect(
      preflightCredits({
        client: buildClient(),
        action: "workflow",
        billingUrl: "https://diffmode.app/app/billing",
      }),
    ).rejects.toBeInstanceOf(PricingUnavailableError);
  });

  it("throws PricingUnavailableError when backend returns 503 'Pricing configuration unavailable'", async () => {
    // End-to-end: backend's credit_costs table is unreachable, so
    // /billing/balance returns HTTP 503 from PricingConfigError. The
    // CLI must surface this as exit 11, not exit 9, before preflight's
    // runtime guards ever run.
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json(
          { detail: "Pricing configuration unavailable" },
          { status: 503 },
        ),
      ),
    );
    try {
      await preflightCredits({
        client: buildClient(),
        action: "workflow",
        billingUrl: "https://diffmode.app/app/billing",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PricingUnavailableError);
      const e = err as PricingUnavailableError;
      expect(e.exitCode).toBe(11);
      expect(e.code).toBe("pricing_unavailable");
    }
  });

  it("throws PricingUnavailableError when credit_costs is missing the requested action key", async () => {
    server.use(
      http.get(`${API_BASE}/billing/balance`, () =>
        HttpResponse.json({
          balance: 50,
          has_stripe_customer: true,
          has_purchased: true,
          // Partial matrix — `workflow` key missing.
          credit_costs: {
            unlock: 2,
            "idea-eval": 1,
            "smoke-test": 1,
            run: 0,
          },
        } as unknown as CreditBalancePayload),
      ),
    );
    try {
      await preflightCredits({
        client: buildClient(),
        action: "workflow",
        billingUrl: "https://diffmode.app/app/billing",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PricingUnavailableError);
      const e = err as PricingUnavailableError;
      expect(e.message).toMatch(/workflow/);
    }
  });
});
