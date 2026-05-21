import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveToken, type CredentialStoreLike } from "../src/lib/token";

function fakeStore(token: string | null): CredentialStoreLike {
  return {
    async load(_profile?: string) {
      void _profile;
      return token;
    },
    async store() {},
    async clear() {},
  };
}

describe("resolveToken — precedence", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    env = {};
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--token wins over env + stored", async () => {
    const got = await resolveToken({
      cliToken: "dm_pat_FROM_CLI",
      env: { DIFFMODE_TOKEN: "dm_pat_FROM_ENV" },
      store: fakeStore("dm_pat_FROM_STORE"),
    });
    expect(got).toBe("dm_pat_FROM_CLI");
  });

  it("env wins over stored when --token absent", async () => {
    const got = await resolveToken({
      env: { DIFFMODE_TOKEN: "dm_pat_FROM_ENV" },
      store: fakeStore("dm_pat_FROM_STORE"),
    });
    expect(got).toBe("dm_pat_FROM_ENV");
  });

  it("falls back to stored when CLI + env absent", async () => {
    const got = await resolveToken({
      env,
      store: fakeStore("dm_pat_FROM_STORE"),
    });
    expect(got).toBe("dm_pat_FROM_STORE");
  });

  it("returns null when nothing available", async () => {
    const got = await resolveToken({ env, store: fakeStore(null) });
    expect(got).toBeNull();
  });

  it("treats an empty --token as absent (falls through to env)", async () => {
    const got = await resolveToken({
      cliToken: "",
      env: { DIFFMODE_TOKEN: "dm_pat_FROM_ENV" },
      store: fakeStore(null),
    });
    expect(got).toBe("dm_pat_FROM_ENV");
  });

  it("respects the requested profile when calling the store", async () => {
    const seen: string[] = [];
    const store: CredentialStoreLike = {
      async load(profile?: string) {
        seen.push(profile ?? "<none>");
        return "dm_pat_LOADED";
      },
      async store() {},
      async clear() {},
    };
    await resolveToken({ env, store, profile: "work" });
    expect(seen).toEqual(["work"]);
  });
});
