import { buildClient } from "../../lib/submit-helpers";
import { printJson, printError } from "../../lib/output";
import { fetchBalance } from "../../lib/preflight";

export interface BillingBalanceCommandOptions {
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
}

export async function billingBalanceCommand(
  opts: BillingBalanceCommandOptions,
): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  try {
    const balance = await fetchBalance(client);
    printJson({
      balance: balance.balance,
      has_purchased: balance.has_purchased,
    });
  } catch (err) {
    printError(err);
  }
}
