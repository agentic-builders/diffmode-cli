export const DEFAULT_BILLING_URL = "https://diffmode.app/app/billing";

export interface ResolveBillingUrlOptions {
  override?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveBillingUrl(opts: ResolveBillingUrlOptions = {}): string {
  if (opts.override && opts.override.length > 0) return opts.override;
  const env = opts.env ?? process.env;
  const fromEnv = env["DIFFMODE_BILLING_URL"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_BILLING_URL;
}
