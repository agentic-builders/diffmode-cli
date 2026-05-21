export interface CredentialStoreLike {
  store(token: string, profile?: string): Promise<void>;
  load(profile?: string): Promise<string | null>;
  clear(profile?: string): Promise<void>;
}

export interface ResolveTokenOptions {
  cliToken?: string | null | undefined;
  env?: NodeJS.ProcessEnv;
  store?: CredentialStoreLike;
  profile?: string;
}

export async function resolveToken(
  opts: ResolveTokenOptions,
): Promise<string | null> {
  const cli = opts.cliToken;
  if (cli && cli.length > 0) return cli;

  const env = opts.env ?? process.env;
  const envToken = env["DIFFMODE_TOKEN"];
  if (envToken && envToken.length > 0) return envToken;

  if (opts.store) {
    const stored = await opts.store.load(opts.profile);
    if (stored && stored.length > 0) return stored;
  }

  return null;
}
