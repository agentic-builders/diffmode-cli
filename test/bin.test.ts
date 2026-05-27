import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { applyGlobals, buildProgram, getVersion, main } from "../src/bin";
import { getOutputConfig, resetOutputConfig } from "../src/lib/output";

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
    return undefined as never;
  }) as any);
  return captured;
}

describe("buildProgram global options", () => {
  it("registers --json/--no-color/--quiet/--verbose/--yes/--token/--profile/--timeout", () => {
    const program = buildProgram();
    const flags = program.options.map((o) => o.long);
    expect(flags).toContain("--json");
    expect(flags).toContain("--no-color");
    expect(flags).toContain("--quiet");
    expect(flags).toContain("--verbose");
    expect(flags).toContain("--yes");
    expect(flags).toContain("--token");
    expect(flags).toContain("--profile");
    expect(flags).toContain("--timeout");
  });

  it("does NOT register --idempotency-key as a global option (subcommand-scoped only)", () => {
    const program = buildProgram();
    const flags = program.options.map((o) => o.long);
    expect(flags).not.toContain("--idempotency-key");
  });

  it("does NOT register --jq (dropped from 0.1.0)", () => {
    const program = buildProgram();
    const flags = program.options.map((o) => o.long);
    expect(flags).not.toContain("--jq");
  });

  it("--timeout defaults to 60 seconds", () => {
    const program = buildProgram();
    const timeoutOpt = program.options.find((o) => o.long === "--timeout");
    expect(timeoutOpt?.defaultValue).toBe(60);
  });
});

describe("billing surface (Task 6 — read-only)", () => {
  function findCmd(program: ReturnType<typeof buildProgram>, name: string) {
    return program.commands.find((c) => c.name() === name);
  }

  it("registers account/billing/limits", () => {
    const program = buildProgram();
    expect(findCmd(program, "account")).toBeDefined();
    expect(findCmd(program, "billing")).toBeDefined();
    expect(findCmd(program, "limits")).toBeDefined();
  });

  it("billing sub-tree has balance + history but NO topup", () => {
    const program = buildProgram();
    const billing = findCmd(program, "billing");
    expect(billing).toBeDefined();
    const subs = billing!.commands.map((c) => c.name());
    expect(subs).toContain("balance");
    expect(subs).toContain("history");
    expect(subs).not.toContain("topup");
  });

  it("submit commands expose --no-preflight (subcommand-scoped, not global)", () => {
    const program = buildProgram();
    const globals = program.options.map((o) => o.long);
    expect(globals).not.toContain("--no-preflight");
    expect(globals).not.toContain("--preflight");
    for (const name of [
      "run",
      "workflow",
      "unlock",
      "idea-eval",
      "smoke-test",
    ]) {
      const cmd = findCmd(program, name);
      expect(cmd, name).toBeDefined();
      const flags = cmd!.options.map((o) => o.long);
      expect(flags, `${name} should expose --no-preflight`).toContain(
        "--no-preflight",
      );
    }
  });
});

describe("jobs watch flag surface", () => {
  function findCmd(program: ReturnType<typeof buildProgram>, name: string) {
    return program.commands.find((c) => c.name() === name);
  }

  it("`jobs watch` exposes --wait (not --timeout) for total polling wait", () => {
    const program = buildProgram();
    const jobs = findCmd(program, "jobs");
    expect(jobs).toBeDefined();
    const watch = jobs!.commands.find((c) => c.name() === "watch");
    expect(watch).toBeDefined();
    const flags = watch!.options.map((o) => o.long);
    expect(flags).toContain("--wait");
    expect(flags).not.toContain("--timeout");
  });
});

describe("skill surface (Task 10)", () => {
  function findCmd(program: ReturnType<typeof buildProgram>, name: string) {
    return program.commands.find((c) => c.name() === name);
  }

  it("registers `skill` with `show` + `install` subcommands", () => {
    const program = buildProgram();
    const skill = findCmd(program, "skill");
    expect(skill).toBeDefined();
    const subs = skill!.commands.map((c) => c.name());
    expect(subs).toContain("show");
    expect(subs).toContain("install");
  });

  it("`skill install` exposes --target/--yes/--dry-run/--print-paths", () => {
    const program = buildProgram();
    const install = findCmd(program, "skill")!.commands.find(
      (c) => c.name() === "install",
    );
    expect(install).toBeDefined();
    const flags = install!.options.map((o) => o.long);
    expect(flags).toContain("--target");
    expect(flags).toContain("--yes");
    expect(flags).toContain("--dry-run");
    expect(flags).toContain("--print-paths");
  });
});

describe("applyGlobals --no-color wiring", () => {
  beforeEach(() => {
    resetOutputConfig();
    delete process.env["NO_COLOR"];
  });
  afterEach(() => {
    resetOutputConfig();
    delete process.env["NO_COLOR"];
  });

  it("--no-color sets OutputConfig.noColor=true (commander stores it as color:false)", () => {
    applyGlobals({ color: false } as Parameters<typeof applyGlobals>[0]);
    expect(getOutputConfig().noColor).toBe(true);
  });

  it("default (color undefined) leaves noColor=false", () => {
    applyGlobals({} as Parameters<typeof applyGlobals>[0]);
    expect(getOutputConfig().noColor).toBe(false);
  });

  it("NO_COLOR env var also forces noColor=true", () => {
    process.env["NO_COLOR"] = "1";
    applyGlobals({} as Parameters<typeof applyGlobals>[0]);
    expect(getOutputConfig().noColor).toBe(true);
  });
});

describe("main() --version", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints plain version on TTY", async () => {
    const cap = captureStreams();
    await main(["--version"]);
    expect(cap.stdout.trim()).toBe(getVersion());
  });

  it("--version --json emits {schema_version, version, node, platform}", async () => {
    const cap = captureStreams();
    await main(["--version", "--json"]);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.version).toBe(getVersion());
    expect(parsed.node).toBe(process.version);
    expect(parsed.platform).toBe(process.platform);
  });

  it("--json --version emits the same envelope (order-independent)", async () => {
    const cap = captureStreams();
    await main(["--json", "--version"]);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.version).toBe(getVersion());
  });
});

describe("resolveActiveToken wiring (regression: env token reaches non-auth handlers)", () => {
  // Before the Task 11 fix, only auth/whoami consulted the credential
  // resolver — every other action handler passed `globals.token` directly,
  // so a user who ran `diffmode login` then `diffmode account` (no --token,
  // env unset) silently sent no Authorization header. This test pins that
  // `main(["account"])` with only DIFFMODE_TOKEN set actually threads that
  // env value through to the HTTP layer.
  const API_BASE = "https://api.test/public/v1";
  const ORIGINAL_API_BASE = process.env["DIFFMODE_API_BASE"];
  const ORIGINAL_DIFFMODE_TOKEN = process.env["DIFFMODE_TOKEN"];
  const server = setupServer();

  beforeEach(() => {
    server.listen({ onUnhandledRequest: "error" });
    resetOutputConfig();
    process.env["DIFFMODE_API_BASE"] = API_BASE;
  });
  afterEach(() => {
    server.resetHandlers();
    server.close();
    vi.restoreAllMocks();
    resetOutputConfig();
    if (ORIGINAL_API_BASE === undefined) {
      delete process.env["DIFFMODE_API_BASE"];
    } else {
      process.env["DIFFMODE_API_BASE"] = ORIGINAL_API_BASE;
    }
    if (ORIGINAL_DIFFMODE_TOKEN === undefined) {
      delete process.env["DIFFMODE_TOKEN"];
    } else {
      process.env["DIFFMODE_TOKEN"] = ORIGINAL_DIFFMODE_TOKEN;
    }
  });

  it("DIFFMODE_TOKEN flows through main(['account']) to Authorization header", async () => {
    process.env["DIFFMODE_TOKEN"] = "dm_pat_env_token_wiring_xxxxxxxxxxxx";
    let receivedAuth: string | null = null;
    server.use(
      http.get(`${API_BASE}/billing/balance`, ({ request }) => {
        receivedAuth = request.headers.get("authorization");
        return HttpResponse.json({
          balance: 1,
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
    );
    const cap = captureStreams();
    await main(["account", "--json"]);
    expect(cap.exitCode ?? 0).toBe(0);
    expect(receivedAuth).toBe(
      "Bearer dm_pat_env_token_wiring_xxxxxxxxxxxx",
    );
  });
});

describe("numeric flag validation (NaN-silent foot-gun)", () => {
  // Before this fix, `Number.parseInt("abc", 10)` was used unchecked for
  // `--timeout`, `--limit`, `--offset`, and `--max-tokens` arg parsers.
  // Garbage input silently produced NaN, which `setTimeout(..., NaN)`
  // coerced to ~0 ms — so every HTTP call appeared to "time out" with a
  // confusing network error instead of a usage error.
  it("--timeout abc is rejected as InvalidArgumentError", async () => {
    const cap = captureStreams();
    const exit = await main(["--timeout", "abc", "account"]);
    // Commander surfaces argParser failures as a non-zero CommanderError
    // exit code with a usage message on stderr.
    expect(exit).not.toBe(0);
    expect(cap.stderr).toMatch(/--timeout/);
  });
});
