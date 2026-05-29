export const DEFAULT_BILLING_URL = "https://diffmode.app/app/billing";

export interface ResolveBillingUrlOptions {
  override?: string;
  env?: NodeJS.ProcessEnv;
}

/** Append channel=cli so the web billing page shows the CLI credit-packs view. */
function withCliChannel(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("channel", "cli");
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}channel=cli`;
  }
}

export function resolveBillingUrl(opts: ResolveBillingUrlOptions = {}): string {
  let base = DEFAULT_BILLING_URL;
  if (opts.override && opts.override.length > 0) {
    base = opts.override;
  } else {
    const env = opts.env ?? process.env;
    const fromEnv = env["DIFFMODE_BILLING_URL"];
    if (fromEnv && fromEnv.length > 0) base = fromEnv;
  }
  return withCliChannel(base);
}
