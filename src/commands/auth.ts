import { HttpClient, DEFAULT_API_BASE } from "../lib/http";
import { printJson, printError, printProgress } from "../lib/output";
import { AuthError } from "../lib/errors";
import type { CredentialStore } from "../lib/credentials";
import { createCredentialStore } from "../lib/credentials";
import { resolveToken } from "../lib/token";

const ACCESS_TOKENS_PATH = "/access-tokens";

interface AccessTokenMetadata {
  id: string;
  name: string;
  token_prefix: string;
  created_at: string;
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
}

interface ListTokensResponse {
  tokens: AccessTokenMetadata[];
}

export interface LoginOptions {
  token: string;
  apiBase?: string;
  store?: CredentialStore;
  profile?: string;
  timeoutMs?: number;
}

export interface LogoutOptions {
  store?: CredentialStore;
  profile?: string;
}

export interface WhoamiOptions {
  apiBase?: string;
  store?: CredentialStore;
  profile?: string;
  cliToken?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function tokenPrefix(token: string): string {
  // Mirrors the server's `_DISPLAY_PREFIX_LEN = 12` convention.
  return token.slice(0, 12);
}

async function probeAccessTokens(
  client: HttpClient,
): Promise<ListTokensResponse> {
  const r = await client.get<ListTokensResponse>(ACCESS_TOKENS_PATH);
  return r.data;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
  const store = opts.store ?? createCredentialStore();
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const client = new HttpClient({
    baseUrl: apiBase,
    token: opts.token,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  let listed: ListTokensResponse;
  try {
    listed = await probeAccessTokens(client);
  } catch (err) {
    printError(err);
  }

  await store.store(opts.token, opts.profile);

  printJson({
    authenticated: true,
    tokens_registered: listed.tokens.length,
    current_token_prefix: tokenPrefix(opts.token),
  });
}

export async function logoutCommand(opts: LogoutOptions = {}): Promise<void> {
  const store = opts.store ?? createCredentialStore();
  await store.clear(opts.profile);
  printJson({ authenticated: false });
}

export async function whoamiCommand(opts: WhoamiOptions = {}): Promise<void> {
  const store = opts.store ?? createCredentialStore();
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;

  const resolveArgs: Parameters<typeof resolveToken>[0] = { store };
  if (opts.cliToken !== undefined) resolveArgs.cliToken = opts.cliToken;
  if (opts.env !== undefined) resolveArgs.env = opts.env;
  if (opts.profile !== undefined) resolveArgs.profile = opts.profile;

  const token = await resolveToken(resolveArgs);

  if (!token) {
    printError(
      new AuthError("No valid token. Run `diffmode login` to authenticate."),
    );
    return;
  }

  const client = new HttpClient({
    baseUrl: apiBase,
    token,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  let listed: ListTokensResponse;
  try {
    listed = await probeAccessTokens(client);
  } catch (err) {
    printError(err);
  }

  printJson({
    authenticated: true,
    tokens_registered: listed.tokens.length,
    current_token_prefix: tokenPrefix(token),
  });
}

export async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function progressLine(line: string): void {
  printProgress(line);
}
