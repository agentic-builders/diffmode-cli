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

  it("appends channel=cli to the documented default when env var is unset", () => {
    expect(resolveBillingUrl()).toBe("https://diffmode.app/app/billing?channel=cli");
    expect(DEFAULT_BILLING_URL).toBe("https://diffmode.app/app/billing");
  });

  it("appends channel=cli to DIFFMODE_BILLING_URL when set", () => {
    process.env["DIFFMODE_BILLING_URL"] = "https://staging.diffmode.app/app/billing";
    expect(resolveBillingUrl()).toBe(
      "https://staging.diffmode.app/app/billing?channel=cli",
    );
  });

  it("falls back to default (with channel) when env var is empty string", () => {
    process.env["DIFFMODE_BILLING_URL"] = "";
    expect(resolveBillingUrl()).toBe("https://diffmode.app/app/billing?channel=cli");
  });

  it("explicit override beats env var (and still gets channel)", () => {
    process.env["DIFFMODE_BILLING_URL"] = "https://env.example/billing";
    expect(resolveBillingUrl({ override: "https://override.example/billing" })).toBe(
      "https://override.example/billing?channel=cli",
    );
  });

  it("accepts an explicit env map (for test isolation)", () => {
    expect(
      resolveBillingUrl({ env: { DIFFMODE_BILLING_URL: "https://custom/url" } }),
    ).toBe("https://custom/url?channel=cli");
  });

  it("preserves an existing query string on the configured URL", () => {
    expect(
      resolveBillingUrl({ env: { DIFFMODE_BILLING_URL: "https://x.example/billing?ref=abc" } }),
    ).toBe("https://x.example/billing?ref=abc&channel=cli");
  });

  it("overwrites an existing channel param instead of duplicating it", () => {
    expect(
      resolveBillingUrl({ override: "https://x.example/billing?channel=web" }),
    ).toBe("https://x.example/billing?channel=cli");
  });

  it("keeps the query before the fragment on an absolute URL", () => {
    expect(resolveBillingUrl({ override: "https://x.example/billing#help" })).toBe(
      "https://x.example/billing?channel=cli#help",
    );
  });

  it("handles a relative URL: query before fragment, no duplicate channel", () => {
    expect(resolveBillingUrl({ override: "/app/billing#help" })).toBe(
      "/app/billing?channel=cli#help",
    );
    expect(resolveBillingUrl({ override: "/app/billing?channel=web" })).toBe(
      "/app/billing?channel=cli",
    );
  });
});
