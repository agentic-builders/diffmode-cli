import { buildClient } from "../lib/submit-helpers";
import { printJson, printError } from "../lib/output";
import { fetchBalance } from "../lib/preflight";
import { resolveBillingUrl } from "../lib/billing-url";

export const RATE_LIMIT_WINDOW_H = 24;
export const RATE_LIMIT_MAX = 3;

export interface LimitsCommandOptions {
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
}

export async function limitsCommand(opts: LimitsCommandOptions): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  try {
    const balance = await fetchBalance(client);
    printJson({
      credits_available: balance.balance,
      has_purchased: balance.has_purchased,
      rate_limit_window_h: RATE_LIMIT_WINDOW_H,
      rate_limit_max: RATE_LIMIT_MAX,
      billing_url: resolveBillingUrl(),
    });
  } catch (err) {
    printError(err);
  }
}
