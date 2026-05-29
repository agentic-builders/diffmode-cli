export const DEFAULT_BILLING_URL = "https://diffmode.app/app/billing";

export interface ResolveBillingUrlOptions {
  override?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Append channel=cli so the web billing page shows the CLI credit-packs view.
 *
 * Parses with a sentinel base so relative URLs go through the URL parser too:
 * this overwrites any existing `channel` param and keeps the query before the
 * fragment automatically. (A hand-rolled string append did neither — see PR #9
 * review: it produced `/billing#help?channel=cli` and could duplicate `channel`.)
 */
function withCliChannel(url: string): string {
  const SENTINEL_BASE = "https://diffmode.invalid";
  let parsed: URL;
  try {
    parsed = new URL(url, SENTINEL_BASE);
  } catch {
    return url; // genuinely unparseable — leave untouched
  }
  parsed.searchParams.set("channel", "cli");
  // Relative input → return only the relative portion (strip the sentinel origin).
  return parsed.origin === SENTINEL_BASE
    ? parsed.pathname + parsed.search + parsed.hash
    : parsed.toString();
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
