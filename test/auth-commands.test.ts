import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { createCredentialStore } from "../src/lib/credentials";
import { resetOutputConfig, setOutputConfig } from "../src/lib/output";
import {
  loginCommand,
  logoutCommand,
  whoamiCommand,
} from "../src/commands/auth";

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

describe("login", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diffmode-login-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stores token + prints {authenticated:true, tokens_registered:N} on 200", async () => {
    let sawBearer: string | null = null;
    server.use(
      http.get(`${API_BASE}/access-tokens`, ({ request }) => {
        sawBearer = request.headers.get("authorization");
        return HttpResponse.json({
          tokens: [
            {
              id: "t-1",
              name: "ci-laptop",
              token_prefix: "dm_pat_aaaa",
              created_at: "2026-05-20T00:00:00Z",
            },
            {
              id: "t-2",
              name: "mobile",
              token_prefix: "dm_pat_bbbb",
              created_at: "2026-05-19T00:00:00Z",
            },
          ],
        });
      }),
    );

    const cap = captureStreams();
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await loginCommand({
      token: "dm_pat_login_token_aaaaaaaaaaaaaaaa",
      apiBase: API_BASE,
      store,
    });

    expect(sawBearer).toBe(
      "Bearer dm_pat_login_token_aaaaaaaaaaaaaaaa",
    );
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.schema_version).toBe("1");
    expect(parsed.authenticated).toBe(true);
    expect(parsed.tokens_registered).toBe(2);
    expect(await store.load()).toBe("dm_pat_login_token_aaaaaaaaaaaaaaaa");
  });

  it("never echoes the raw PAT on stdout after acceptance", async () => {
    server.use(
      http.get(`${API_BASE}/access-tokens`, () =>
        HttpResponse.json({ tokens: [] }),
      ),
    );
    const cap = captureStreams();
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await loginCommand({
      token: "dm_pat_NEVER_ECHO_THIS_TOKEN_xxxxx",
      apiBase: API_BASE,
      store,
    });
    expect(cap.stdout).not.toContain("dm_pat_NEVER_ECHO_THIS_TOKEN_xxxxx");
    expect(cap.stderr).not.toContain("dm_pat_NEVER_ECHO_THIS_TOKEN_xxxxx");
  });

  it("exits 4 with 'Invalid or revoked access token' on 401", async () => {
    server.use(
      http.get(`${API_BASE}/access-tokens`, () =>
        HttpResponse.json(
          { detail: "Invalid or revoked access token" },
          { status: 401 },
        ),
      ),
    );
    const cap = captureStreams();
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await expect(
      loginCommand({
        token: "dm_pat_bad_token_xxxxxxxxxxxxxxx",
        apiBase: API_BASE,
        store,
      }),
    ).rejects.toThrow(/__exit__:4/);
    expect(cap.exitCode).toBe(4);
    const parsedErr = JSON.parse(cap.stderr);
    expect(parsedErr.error.code).toBe("auth");
    // token must NOT be persisted on 401
    expect(await store.load()).toBeNull();
  });

  it("uses /access-tokens (not /billing/balance) for the identity probe", async () => {
    let calledBalance = false;
    let calledTokens = false;
    server.use(
      http.get(`${API_BASE}/billing/balance`, () => {
        calledBalance = true;
        return HttpResponse.json({ balance: 0 });
      }),
      http.get(`${API_BASE}/access-tokens`, () => {
        calledTokens = true;
        return HttpResponse.json({ tokens: [] });
      }),
    );
    captureStreams();
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await loginCommand({
      token: "dm_pat_probe_token_xxxxxxxxxxxxx",
      apiBase: API_BASE,
      store,
    });
    expect(calledTokens).toBe(true);
    expect(calledBalance).toBe(false);
  });
});

describe("logout", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diffmode-logout-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("clears credentials and prints success JSON", async () => {
    const cap = captureStreams();
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await store.store("dm_pat_stored_xxxxxxxxxxxxxxxxx");
    await logoutCommand({ store });
    expect(await store.load()).toBeNull();
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.authenticated).toBe(false);
  });

  it("is idempotent — no-op when no token stored, exit 0", async () => {
    const cap = captureStreams();
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await logoutCommand({ store });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.authenticated).toBe(false);
    expect(existsSync(join(tmp, "auth.json"))).toBe(false);
  });
});

describe("whoami", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diffmode-whoami-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prints {authenticated, tokens_registered, current_token_prefix} on 200", async () => {
    server.use(
      http.get(`${API_BASE}/access-tokens`, () =>
        HttpResponse.json({
          tokens: [
            {
              id: "t-1",
              name: "ci-laptop",
              token_prefix: "dm_pat_aaaa",
              created_at: "2026-05-20T00:00:00Z",
            },
          ],
        }),
      ),
    );
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await store.store("dm_pat_partyhat_zzzzzzzzzzzzzzzzzzzz");
    const cap = captureStreams();
    await whoamiCommand({ apiBase: API_BASE, store });
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.tokens_registered).toBe(1);
    expect(parsed.current_token_prefix).toBe("dm_pat_party");
    expect(parsed.current_token_prefix).not.toContain("zzzzzzzz");
  });

  it("exits 4 when no token stored (no probe attempted)", async () => {
    let probed = false;
    server.use(
      http.get(`${API_BASE}/access-tokens`, () => {
        probed = true;
        return HttpResponse.json({ tokens: [] });
      }),
    );
    const cap = captureStreams();
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await expect(whoamiCommand({ apiBase: API_BASE, store })).rejects.toThrow(
      /__exit__:4/,
    );
    expect(cap.exitCode).toBe(4);
    expect(probed).toBe(false);
  });

  it("exits 4 on 401 (token revoked)", async () => {
    server.use(
      http.get(`${API_BASE}/access-tokens`, () =>
        HttpResponse.json(
          { detail: "Invalid or revoked access token" },
          { status: 401 },
        ),
      ),
    );
    const store = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: () => {},
    });
    await store.store("dm_pat_revoked_token_xxxxxxxxxxxxx");
    const cap = captureStreams();
    await expect(whoamiCommand({ apiBase: API_BASE, store })).rejects.toThrow(
      /__exit__:4/,
    );
    expect(cap.exitCode).toBe(4);
  });
});
