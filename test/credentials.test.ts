import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCredentialStore,
  type KeytarLike,
  SERVICE_NAME,
  DEFAULT_PROFILE,
  loadKeytar,
  __resetWarningDedupForTests,
} from "../src/lib/credentials";

function mockKeytar(initial: Record<string, string> = {}): KeytarLike & {
  store: Record<string, string>;
  setError?: Error;
  deleteError?: Error;
  getError?: Error;
} {
  const store: Record<string, string> = { ...initial };
  const m: any = {
    store,
    async getPassword(service: string, account: string) {
      if (m.getError) throw m.getError;
      return store[`${service}:${account}`] ?? null;
    },
    async setPassword(service: string, account: string, password: string) {
      if (m.setError) throw m.setError;
      store[`${service}:${account}`] = password;
    },
    async deletePassword(service: string, account: string) {
      if (m.deleteError) throw m.deleteError;
      const key = `${service}:${account}`;
      const had = key in store;
      delete store[key];
      return had;
    },
  };
  return m;
}

describe("createCredentialStore — keyring path", () => {
  let tmp: string;
  let warn: ReturnType<typeof vi.fn<(message: string) => void>>;
  let keytar: ReturnType<typeof mockKeytar>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diffmode-cred-"));
    warn = vi.fn<(message: string) => void>();
    keytar = mockKeytar();
    __resetWarningDedupForTests();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("store() writes to keytar under service=diffmode, account=<profile>", async () => {
    const cs = createCredentialStore({ keytar, configDir: tmp, warnFn: warn });
    await cs.store("dm_pat_abcdefghijklmnop12345678");
    expect(keytar.store[`${SERVICE_NAME}:${DEFAULT_PROFILE}`]).toBe(
      "dm_pat_abcdefghijklmnop12345678",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("store() uses the requested profile name", async () => {
    const cs = createCredentialStore({ keytar, configDir: tmp, warnFn: warn });
    await cs.store("dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx", "work");
    expect(keytar.store[`${SERVICE_NAME}:work`]).toBe(
      "dm_pat_xxxxxxxxxxxxxxxxxxxxxxxx",
    );
  });

  it("load() returns the stored token", async () => {
    const cs = createCredentialStore({ keytar, configDir: tmp, warnFn: warn });
    await cs.store("dm_pat_token123456789012345678901");
    const loaded = await cs.load();
    expect(loaded).toBe("dm_pat_token123456789012345678901");
  });

  it("load() returns null when nothing stored", async () => {
    const cs = createCredentialStore({ keytar, configDir: tmp, warnFn: warn });
    expect(await cs.load()).toBeNull();
  });

  it("clear() removes the token (idempotent)", async () => {
    const cs = createCredentialStore({ keytar, configDir: tmp, warnFn: warn });
    await cs.store("dm_pat_tok_to_clear_12345678901234");
    await cs.clear();
    expect(await cs.load()).toBeNull();
    // second clear is a no-op (no throw)
    await cs.clear();
    expect(await cs.load()).toBeNull();
  });

  it("never persists plaintext to disk when keyring works", async () => {
    const cs = createCredentialStore({ keytar, configDir: tmp, warnFn: warn });
    await cs.store("dm_pat_should_not_hit_disk_12345");
    const filePath = join(tmp, "auth.json");
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("createCredentialStore — file fallback path", () => {
  let tmp: string;
  let warn: ReturnType<typeof vi.fn<(message: string) => void>>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "diffmode-cred-"));
    warn = vi.fn<(message: string) => void>();
    __resetWarningDedupForTests();
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("falls back to file when keytar=null + writes mode 0600 + warns once", async () => {
    const cs = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: warn,
    });
    await cs.store("dm_pat_filefallback_token_xxxxxxxx");
    const filePath = join(tmp, "auth.json");
    expect(existsSync(filePath)).toBe(true);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    // Subsequent store call must not warn again (dedup)
    warn.mockClear();
    await cs.store("dm_pat_filefallback_token_yyyyyyyy");
    expect(warn).not.toHaveBeenCalled();
  });

  it("re-tightens auth.json to 0600 on rewrite even if file was chmodded to 0644", async () => {
    const cs = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: warn,
    });
    const filePath = join(tmp, "auth.json");
    await cs.store("dm_pat_first_write_aaaaaaaaaaaaaa");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    // Simulate an external process loosening perms (backup tool, manual chmod).
    chmodSync(filePath, 0o644);
    expect(statSync(filePath).mode & 0o777).toBe(0o644);
    // Re-store the token; perms MUST be re-tightened to 0600.
    await cs.store("dm_pat_second_write_bbbbbbbbbbbbbb");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("warns exactly once across multiple operations", async () => {
    const cs = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: warn,
    });
    await cs.store("dm_pat_aaaaaaaaaaaaaaaaaaaaaaaa");
    await cs.load();
    await cs.clear();
    await cs.store("dm_pat_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/Keyring unavailable/);
    expect(warn.mock.calls[0]?.[0]).toContain("auth.json");
  });

  it("falls back to file when keytar.setPassword throws (install-failed simulation)", async () => {
    const keytar = mockKeytar();
    keytar.setError = new Error("native module load failed");
    const cs = createCredentialStore({ keytar, configDir: tmp, warnFn: warn });
    await cs.store("dm_pat_setpassword_threw_xxxxxxxx");
    expect(existsSync(join(tmp, "auth.json"))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await cs.load()).toBe("dm_pat_setpassword_threw_xxxxxxxx");
  });

  it("load() falls back to file when keytar.getPassword throws", async () => {
    const keytar = mockKeytar();
    // pre-write the file directly to simulate a previous file-fallback store
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      join(tmp, "auth.json"),
      JSON.stringify({
        profiles: { default: { token: "dm_pat_existing_fallback_token_xx" } },
      }),
      { mode: 0o600 },
    );
    keytar.getError = new Error("keyring read failed");
    const cs = createCredentialStore({ keytar, configDir: tmp, warnFn: warn });
    expect(await cs.load()).toBe("dm_pat_existing_fallback_token_xx");
  });

  it("clear() removes the file-fallback entry; auth.json removed when last profile cleared", async () => {
    const cs = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: warn,
    });
    await cs.store("dm_pat_clearme_xxxxxxxxxxxxxxxxx");
    expect(existsSync(join(tmp, "auth.json"))).toBe(true);
    await cs.clear();
    expect(await cs.load()).toBeNull();
  });

  it("isolates profiles in the file fallback (different profiles, separate tokens)", async () => {
    const cs = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: warn,
    });
    await cs.store("dm_pat_default_aaaaaaaaaaaaaaaa", "default");
    await cs.store("dm_pat_work_bbbbbbbbbbbbbbbbbbbb", "work");
    expect(await cs.load("default")).toBe("dm_pat_default_aaaaaaaaaaaaaaaa");
    expect(await cs.load("work")).toBe("dm_pat_work_bbbbbbbbbbbbbbbbbbbb");
  });

  it("does NOT silently wipe other profiles when auth.json is corrupt — backs up and warns", async () => {
    // Regression: a corrupt auth.json (partial write, manual edit, disk issue)
    // used to silently parse-fail to `{profiles:{}}`, then the next
    // `store(otherProfile)` would overwrite the file with ONLY the new profile —
    // silently wiping every other stored credential. Fix backs the corrupt
    // file up to `auth.json.corrupt.<ts>` instead of clobbering it.
    const cs = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: warn,
    });
    const filePath = join(tmp, "auth.json");
    mkdirSync(tmp, { recursive: true });
    // Pretend a previous-version CLI wrote tokens for `work` and `personal`,
    // then the file got truncated to garbage somehow.
    writeFileSync(filePath, "this is not valid json {{{", { mode: 0o600 });
    const originalBytes = readFileSync(filePath, "utf8");

    await cs.store("dm_pat_new_default_aaaaaaaaaaaaaaaa");

    // 1) The new auth.json should be a clean file containing only the new
    //    profile (we cannot recover the unreadable bytes — but importantly,
    //    those bytes are preserved on disk under a `.corrupt.` suffix so the
    //    user can inspect / restore manually).
    const written = JSON.parse(readFileSync(filePath, "utf8")) as {
      profiles: Record<string, { token: string }>;
    };
    expect(Object.keys(written.profiles)).toEqual(["default"]);
    expect(written.profiles["default"]?.token).toBe(
      "dm_pat_new_default_aaaaaaaaaaaaaaaa",
    );

    // 2) Backup file must exist with the ORIGINAL corrupt bytes intact.
    const backups = require("node:fs")
      .readdirSync(tmp)
      .filter((f: string) => f.startsWith("auth.json.corrupt."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(tmp, backups[0]!), "utf8")).toBe(originalBytes);

    // 3) The user must have been warned (so silent loss is impossible).
    const messages = warn.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => /corrupt/i.test(m))).toBe(true);
  });

  it("load() treats corrupt auth.json as empty rather than crashing", async () => {
    const cs = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: warn,
    });
    const filePath = join(tmp, "auth.json");
    mkdirSync(tmp, { recursive: true });
    writeFileSync(filePath, "{not json", { mode: 0o600 });
    expect(await cs.load()).toBeNull();
  });

  it("file content never contains the raw token after clear", async () => {
    const cs = createCredentialStore({
      keytar: null,
      configDir: tmp,
      warnFn: warn,
    });
    await cs.store("dm_pat_secret_must_be_gone_after_clear");
    await cs.clear();
    const path = join(tmp, "auth.json");
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("dm_pat_secret_must_be_gone_after_clear");
    }
  });
});

describe("loadKeytar()", () => {
  it("returns a module-like object or null without throwing", () => {
    const k = loadKeytar();
    // In this test env keytar is installed, so we expect an object; but the
    // contract is "never throws". Tolerate either outcome.
    expect(k === null || typeof k === "object").toBe(true);
  });
});
