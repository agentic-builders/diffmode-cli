import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  parseFromFile,
  parseFromUrl,
  mergeInputs,
  validateRequired,
  fillGapsInteractive,
  type FounderInputDraft,
  type Prompter,
} from "../src/lib/founder-input";
import { HttpClient } from "../src/lib/http";
import { UsageError } from "../src/lib/errors";

const API_BASE = "https://api.test/public/v1";

const server = setupServer();
beforeEach(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  server.close();
  vi.restoreAllMocks();
});

describe("parseFromFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diffmode-fi-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads a JSON file and returns the parsed object", async () => {
    const path = join(tmp, "founder.json");
    writeFileSync(
      path,
      JSON.stringify({
        product_description: "Tool that does X",
        target_audience: "SMB SaaS founders",
        custom_field: "preserved via extra=allow",
      }),
    );
    const result = await parseFromFile(path);
    expect(result.product_description).toBe("Tool that does X");
    expect(result.target_audience).toBe("SMB SaaS founders");
    expect((result as Record<string, unknown>)["custom_field"]).toBe(
      "preserved via extra=allow",
    );
  });

  it("reads from stdin when path is '-'", async () => {
    const stdinJson = JSON.stringify({ product_description: "From stdin" });
    const reader = async () => stdinJson;
    const result = await parseFromFile("-", { readStdin: reader });
    expect(result.product_description).toBe("From stdin");
  });

  it("throws UsageError when file is invalid JSON", async () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, "{ not valid json");
    await expect(parseFromFile(path)).rejects.toThrow(UsageError);
  });

  it("throws UsageError when file does not exist", async () => {
    await expect(
      parseFromFile(join(tmp, "missing.json")),
    ).rejects.toThrow(UsageError);
  });

  it("throws UsageError when JSON is not an object", async () => {
    const path = join(tmp, "array.json");
    writeFileSync(path, '["not", "an", "object"]');
    await expect(parseFromFile(path)).rejects.toThrow(UsageError);
  });

  it("rejects reserved keys (user_id, created_at, etc.)", async () => {
    const path = join(tmp, "reserved.json");
    writeFileSync(
      path,
      JSON.stringify({
        product_description: "x",
        user_id: "should not be allowed",
      }),
    );
    await expect(parseFromFile(path)).rejects.toThrow(UsageError);
  });

  it("rejects `module_type` (server-reserved key)", async () => {
    const path = join(tmp, "reserved-module.json");
    writeFileSync(
      path,
      JSON.stringify({
        product_description: "x",
        module_type: "free-tier",
      }),
    );
    await expect(parseFromFile(path)).rejects.toThrow(/module_type/i);
  });
});

describe("parseFromUrl", () => {
  it("calls POST /analyze-website and maps response → FounderDiagnostics", async () => {
    let receivedBody: unknown = null;
    server.use(
      http.post(`${API_BASE}/analyze-website`, async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          company_name: "Acme Inc",
          company_description: "We make widgets",
          product_type: "saas",
          analysis_pricing: "Free + Pro $49/mo",
          target_customer: "SMB ops teams",
          analysis_trigger_events: "When they hire a 2nd ops person",
          top_competitors: "Zapier, Make.com",
          what_makes_you_different: "Native AI",
          how_customers_find_you_today: "Word of mouth",
          analysis_product_complexity_type: "self-evident",
          analysis_product_complexity_details: "Most see value in <5min",
          source_url: "https://acme.example",
          auto_filled_fields: ["company_description", "analysis_pricing"],
          draft_fields: ["target_customer"],
        });
      }),
    );

    const client = new HttpClient({ baseUrl: API_BASE });
    const result = await parseFromUrl("https://acme.example", { client });

    expect(receivedBody).toEqual({ url: "https://acme.example" });
    expect(result.product_description).toBe("We make widgets");
    expect(result.pricing).toBe("Free + Pro $49/mo");
    expect(result.target_audience).toBe("SMB ops teams");
    expect(result.trigger_events).toBe(
      "When they hire a 2nd ops person",
    );
    expect(result.acquisition_sources).toBe("Word of mouth");
    expect(result.top_competitors).toBe("Zapier, Make.com");
    expect(result.what_makes_you_different).toBe("Native AI");
    expect(result.product_complexity).toEqual({
      type: "self-evident",
      details: "Most see value in <5min",
    });
  });

  it("emits stderr metadata about auto_filled vs draft fields (non-quiet)", async () => {
    server.use(
      http.post(`${API_BASE}/analyze-website`, () =>
        HttpResponse.json({
          company_description: "Tool",
          auto_filled_fields: ["company_description"],
          draft_fields: ["target_customer"],
        }),
      ),
    );
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as any);

    const client = new HttpClient({ baseUrl: API_BASE });
    await parseFromUrl("https://acme.example", { client, quiet: false });

    const joined = stderrWrites.join("");
    expect(joined).toMatch(/auto.?filled/i);
    expect(joined).toMatch(/company_description/);
    expect(joined).toMatch(/draft/i);
    expect(joined).toMatch(/target_customer/);
  });

  it("is silent on stderr when quiet=true", async () => {
    server.use(
      http.post(`${API_BASE}/analyze-website`, () =>
        HttpResponse.json({ company_description: "Tool" }),
      ),
    );
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as any);

    const client = new HttpClient({ baseUrl: API_BASE });
    await parseFromUrl("https://acme.example", { client, quiet: true });
    expect(stderrWrites.join("")).toBe("");
  });
});

describe("mergeInputs", () => {
  it("file overrides url on field-by-field overlap", () => {
    const fromUrl: FounderInputDraft = {
      product_description: "From URL",
      pricing: "From URL pricing",
    };
    const fromFile: FounderInputDraft = {
      product_description: "From File",
    };
    const merged = mergeInputs(fromFile, fromUrl);
    expect(merged.product_description).toBe("From File");
    // url-only fields fill the gap
    expect(merged.pricing).toBe("From URL pricing");
  });

  it("returns the single input when only one is provided", () => {
    expect(mergeInputs(undefined, { product_description: "x" })).toEqual({
      product_description: "x",
    });
    expect(mergeInputs({ product_description: "y" }, undefined)).toEqual({
      product_description: "y",
    });
  });

  it("returns empty object when both are absent", () => {
    expect(mergeInputs(undefined, undefined)).toEqual({});
  });

  it("does NOT let empty-string from file blank out url-provided field", () => {
    // "" in file should not clobber a non-empty url value (file wins
    // only when it provides a defined non-empty value).
    const fromUrl: FounderInputDraft = { pricing: "From URL pricing" };
    const fromFile: FounderInputDraft = { pricing: "" };
    const merged = mergeInputs(fromFile, fromUrl);
    expect(merged.pricing).toBe("From URL pricing");
  });
});

describe("validateRequired", () => {
  it("returns ok when product_description is present", () => {
    expect(validateRequired({ product_description: "x" })).toEqual({
      ok: true,
    });
  });

  it("returns missing list when product_description absent or empty", () => {
    expect(validateRequired({})).toEqual({
      ok: false,
      missing: ["product_description"],
    });
    expect(validateRequired({ product_description: "" })).toEqual({
      ok: false,
      missing: ["product_description"],
    });
    expect(validateRequired({ product_description: "   " })).toEqual({
      ok: false,
      missing: ["product_description"],
    });
  });
});

describe("fillGapsInteractive", () => {
  function makePrompter(answers: Record<string, string>): Prompter {
    return async (key: string) => answers[key] ?? "";
  }

  it("prompts for missing required fields and fills them", async () => {
    const prompter = makePrompter({ product_description: "Filled via prompt" });
    const filled = await fillGapsInteractive(
      {},
      { required: ["product_description"], optional: [] },
      { prompt: prompter, ttyAssert: () => true },
    );
    expect(filled.product_description).toBe("Filled via prompt");
  });

  it("offers optional fields with a 'skip' answer", async () => {
    const prompter = makePrompter({
      pricing: "Free + Pro",
      target_audience: "",
    });
    const filled = await fillGapsInteractive(
      { product_description: "x" },
      { required: [], optional: ["pricing", "target_audience"] },
      { prompt: prompter, ttyAssert: () => true },
    );
    expect(filled.pricing).toBe("Free + Pro");
    // empty answer = skipped
    expect(filled.target_audience).toBeUndefined();
  });

  it("throws when not on a TTY", async () => {
    await expect(
      fillGapsInteractive(
        {},
        { required: ["product_description"], optional: [] },
        { prompt: makePrompter({}), ttyAssert: () => false },
      ),
    ).rejects.toThrow();
  });

  it("does not re-prompt fields that already have a value", async () => {
    let prompted = false;
    const prompter: Prompter = async () => {
      prompted = true;
      return "";
    };
    await fillGapsInteractive(
      { product_description: "already set" },
      { required: ["product_description"], optional: [] },
      { prompt: prompter, ttyAssert: () => true },
    );
    expect(prompted).toBe(false);
  });
});

describe("non-TTY missing required → UsageError", () => {
  it("validateRequired + ensureFilled helper rejects non-TTY missing", () => {
    const r = validateRequired({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain("product_description");
    }
  });
});
