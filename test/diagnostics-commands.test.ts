import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  diagnosticsFromUrlCommand,
  diagnosticsValidateCommand,
} from "../src/commands/diagnostics";
import { resetOutputConfig, setOutputConfig } from "../src/lib/output";

const API_BASE = "https://api.test/public/v1";

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
beforeEach(() => {
  server.listen({ onUnhandledRequest: "error" });
  resetOutputConfig();
  setOutputConfig({ json: true });
});
afterEach(() => {
  server.resetHandlers();
  server.close();
  vi.restoreAllMocks();
  resetOutputConfig();
});

describe("diffmode diagnostics from-url", () => {
  it("calls /analyze-website and prints mapped FounderDiagnostics JSON", async () => {
    server.use(
      http.post(`${API_BASE}/analyze-website`, () =>
        HttpResponse.json({
          company_description: "Tool",
          analysis_pricing: "$49/mo",
          target_customer: "ops teams",
        }),
      ),
    );
    const out = captureStreams();
    await diagnosticsFromUrlCommand({
      url: "https://acme.example",
      apiBase: API_BASE,
      token: "dm_pat_test_token_aaaaaaaaaaaaaaaaaaaaa",
    });
    const parsed = JSON.parse(out.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.founder_input.product_description).toBe("Tool");
    expect(parsed.founder_input.pricing).toBe("$49/mo");
    expect(parsed.founder_input.target_audience).toBe("ops teams");
  });

  it("with --save writes to a file and prints the path", async () => {
    server.use(
      http.post(`${API_BASE}/analyze-website`, () =>
        HttpResponse.json({ company_description: "Tool" }),
      ),
    );
    const tmp = mkdtempSync(join(tmpdir(), "diffmode-dx-"));
    const savePath = join(tmp, "founder.json");

    const out = captureStreams();
    try {
      await diagnosticsFromUrlCommand({
        url: "https://acme.example",
        apiBase: API_BASE,
        token: "dm_pat_test_token_aaaaaaaaaaaaaaaaaaaaa",
        save: savePath,
      });
      const written = JSON.parse(readFileSync(savePath, "utf8"));
      expect(written.product_description).toBe("Tool");
      const parsed = JSON.parse(out.stdout);
      expect(parsed.saved_to).toBe(savePath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("diffmode diagnostics validate", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diffmode-dv-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 0 on valid file", async () => {
    const path = join(tmp, "ok.json");
    writeFileSync(
      path,
      JSON.stringify({ product_description: "Real product" }),
    );
    const out = captureStreams();
    await diagnosticsValidateCommand({ path });
    const parsed = JSON.parse(out.stdout);
    expect(parsed.valid).toBe(true);
  });

  it("exit 2 with field-level errors on missing product_description", async () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, JSON.stringify({ pricing: "$10/mo" }));
    const out = captureStreams();
    let threw = false;
    try {
      await diagnosticsValidateCommand({ path });
    } catch (e) {
      // captureStreams() makes process.exit throw — that's expected
      threw = true;
    }
    expect(threw).toBe(true);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("product_description");
  });
});
