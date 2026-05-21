import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_NAME = "diffmode";
export const DEFAULT_PROFILE = "default";

export interface KeytarLike {
  setPassword(
    service: string,
    account: string,
    password: string,
  ): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface CredentialStore {
  store(token: string, profile?: string): Promise<void>;
  load(profile?: string): Promise<string | null>;
  clear(profile?: string): Promise<void>;
}

export interface CredentialStoreOptions {
  keytar?: KeytarLike | null;
  configDir?: string;
  warnFn?: (message: string) => void;
}

interface AuthFile {
  profiles: Record<string, { token: string }>;
}

let warnedAboutFallback = false;

export function __resetWarningDedupForTests(): void {
  warnedAboutFallback = false;
}

export function loadKeytar(): KeytarLike | null {
  try {
    const k = require("keytar");
    if (
      k &&
      typeof k.setPassword === "function" &&
      typeof k.getPassword === "function" &&
      typeof k.deletePassword === "function"
    ) {
      return k as KeytarLike;
    }
    return null;
  } catch {
    return null;
  }
}

function defaultConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "diffmode");
}

function defaultWarn(message: string): void {
  if (warnedAboutFallback) return;
  warnedAboutFallback = true;
  process.stderr.write(message + "\n");
}

function emitWarning(
  configDir: string,
  warnFn: ((m: string) => void) | undefined,
): void {
  const message = `Warning: Keyring unavailable, falling back to plaintext file at ${join(configDir, "auth.json")}`;
  if (warnFn) {
    if (warnedAboutFallback) return;
    warnedAboutFallback = true;
    warnFn(message);
    return;
  }
  defaultWarn(message);
}

class CorruptAuthFileError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause?: unknown,
  ) {
    super(
      `Refusing to read ${path}: file is not valid JSON or missing 'profiles'. ` +
        `Inspect or remove the file (or back it up and re-run \`diffmode login\`).`,
    );
    this.name = "CorruptAuthFileError";
  }
}

// Returns null when the file does not exist. Throws CorruptAuthFileError when
// the file exists but cannot be parsed — callers MUST NOT silently rewrite a
// corrupt file, because that wipes credentials for every other profile.
function readAuthFile(path: string): AuthFile | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new CorruptAuthFileError(path, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CorruptAuthFileError(path, err);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !(parsed as { profiles?: unknown }).profiles ||
    typeof (parsed as { profiles: unknown }).profiles !== "object"
  ) {
    throw new CorruptAuthFileError(path);
  }
  return parsed as AuthFile;
}

function backupCorruptFile(path: string): string {
  const backup = `${path}.corrupt.${Date.now()}`;
  renameSync(path, backup);
  return backup;
}

function writeAuthFile(path: string, dir: string, contents: AuthFile): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(contents, null, 2);
  writeFileSync(path, body, { mode: 0o600 });
  // writeFileSync only honors `mode` on file creation; chmod again so that
  // existing files (e.g. left chmod 644 by a backup tool or sync) get tightened
  // back to 0600 on every login.
  chmodSync(path, 0o600);
}

export function createCredentialStore(
  opts: CredentialStoreOptions = {},
): CredentialStore {
  const keytar = opts.keytar === undefined ? loadKeytar() : opts.keytar;
  const configDir = opts.configDir ?? defaultConfigDir();
  const warnFn = opts.warnFn;
  const filePath = join(configDir, "auth.json");

  async function tryKeytar<T>(
    op: (k: KeytarLike) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (!keytar) return { ok: false };
    try {
      return { ok: true, value: await op(keytar) };
    } catch {
      return { ok: false };
    }
  }

  function fallbackStore(profile: string, token: string): void {
    emitWarning(configDir, warnFn);
    let data: AuthFile;
    try {
      data = readAuthFile(filePath) ?? { profiles: {} };
    } catch (err) {
      if (err instanceof CorruptAuthFileError) {
        // Don't silently clobber: a corrupt file may still hold recoverable
        // credentials for other profiles. Move it aside and start fresh, so
        // the user can inspect and restore by hand.
        const backup = backupCorruptFile(filePath);
        const msg =
          `Warning: ${filePath} was unreadable; moved aside to ${backup}. ` +
          `Inspect/restore other profile tokens manually if needed.`;
        if (warnFn) warnFn(msg);
        else process.stderr.write(msg + "\n");
        data = { profiles: {} };
      } else {
        throw err;
      }
    }
    data.profiles[profile] = { token };
    writeAuthFile(filePath, configDir, data);
  }

  function fallbackLoad(profile: string): string | null {
    if (!existsSync(filePath)) return null;
    let data: AuthFile | null;
    try {
      data = readAuthFile(filePath);
    } catch (err) {
      if (err instanceof CorruptAuthFileError) return null;
      throw err;
    }
    return data?.profiles[profile]?.token ?? null;
  }

  function fallbackClear(profile: string): void {
    if (!existsSync(filePath)) return;
    let data: AuthFile | null;
    try {
      data = readAuthFile(filePath);
    } catch (err) {
      if (err instanceof CorruptAuthFileError) {
        // `clear` is best-effort; nothing to remove if the file is unreadable.
        return;
      }
      throw err;
    }
    if (!data || !(profile in data.profiles)) return;
    delete data.profiles[profile];
    if (Object.keys(data.profiles).length === 0) {
      try {
        unlinkSync(filePath);
      } catch {
        /* ignore */
      }
      return;
    }
    writeAuthFile(filePath, configDir, data);
  }

  return {
    async store(token: string, profile: string = DEFAULT_PROFILE) {
      const r = await tryKeytar((k) =>
        k.setPassword(SERVICE_NAME, profile, token),
      );
      if (r.ok) return;
      fallbackStore(profile, token);
    },

    async load(profile: string = DEFAULT_PROFILE) {
      const r = await tryKeytar((k) => k.getPassword(SERVICE_NAME, profile));
      if (r.ok && r.value !== null) return r.value;
      // Even if keytar succeeded with null, also consult the file fallback —
      // this covers the case where a previous run wrote via fallback (e.g.,
      // keytar install failed then later worked).
      return fallbackLoad(profile);
    },

    async clear(profile: string = DEFAULT_PROFILE) {
      await tryKeytar((k) => k.deletePassword(SERVICE_NAME, profile));
      fallbackClear(profile);
    },
  };
}
