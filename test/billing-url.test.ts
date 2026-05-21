import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveBillingUrl, DEFAULT_BILLING_URL } from "../src/lib/billing-url";

describe("resolveBillingUrl", () => {
  const ORIGINAL = process.env["DIFFMODE_BILLING_URL"];

  beforeEach(() => {
    delete process.env["DIFFMODE_BILLING_URL"];
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env["DIFFMODE_BILLING_URL"];
    } else {
      process.env["DIFFMODE_BILLING_URL"] = ORIGINAL;
    }
  });

  it("returns the documented default when env var is unset", () => {
    expect(resolveBillingUrl()).toBe(DEFAULT_BILLING_URL);
    expect(DEFAULT_BILLING_URL).toBe("https://diffmode.app/app/billing");
  });

  it("returns DIFFMODE_BILLING_URL when set", () => {
    process.env["DIFFMODE_BILLING_URL"] = "https://staging.diffmode.app/app/billing";
    expect(resolveBillingUrl()).toBe("https://staging.diffmode.app/app/billing");
  });

  it("falls back to default when env var is empty string", () => {
    process.env["DIFFMODE_BILLING_URL"] = "";
    expect(resolveBillingUrl()).toBe(DEFAULT_BILLING_URL);
  });

  it("explicit override beats env var", () => {
    process.env["DIFFMODE_BILLING_URL"] = "https://env.example/billing";
    expect(resolveBillingUrl({ override: "https://override.example/billing" })).toBe(
      "https://override.example/billing",
    );
  });

  it("accepts an explicit env map (for test isolation)", () => {
    expect(
      resolveBillingUrl({ env: { DIFFMODE_BILLING_URL: "https://custom/url" } }),
    ).toBe("https://custom/url");
  });
});
