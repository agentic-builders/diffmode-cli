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
    // Source the policy from the server; fall back to the documented
    // constants ONLY when the field is absent (older backend). A strict
    // `=== undefined` check preserves a genuine server `null` (exempt
    // account = no cap) instead of coalescing it back to the free-tier cap.
    const rateLimitMax =
      balance.rate_limit_max === undefined
        ? RATE_LIMIT_MAX
        : balance.rate_limit_max;
    const rateLimitWindowH =
      balance.rate_limit_window_h === undefined
        ? RATE_LIMIT_WINDOW_H
        : balance.rate_limit_window_h;
    printJson({
      credits_available: balance.balance,
      has_purchased: balance.has_purchased,
      rate_limit_window_h: rateLimitWindowH,
      rate_limit_max: rateLimitMax,
      billing_url: resolveBillingUrl(),
      credit_costs: balance.credit_costs,
    });
  } catch (err) {
    printError(err);
  }
}
