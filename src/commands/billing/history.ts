import { buildClient } from "../../lib/submit-helpers";
import { printNdjson, printError, printProgress } from "../../lib/output";

interface CreditTransactionPayload {
  id: string;
  amount: number;
  type: string;
  reason: string | null;
  job_id: string | null;
  stripe_id: string | null;
  balance_after: number;
  created_at: string;
  [key: string]: unknown;
}

interface CreditHistoryResponseShape {
  transactions: CreditTransactionPayload[];
  total: number;
  has_more: boolean;
}

export interface BillingHistoryCommandOptions {
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
  limit?: number;
  offset?: number;
  isTTY?: boolean;
}

export async function billingHistoryCommand(
  opts: BillingHistoryCommandOptions,
): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const qs = new URLSearchParams();
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
  const path = qs.toString() ? `/billing/history?${qs.toString()}` : "/billing/history";

  try {
    const resp = await client.get<CreditHistoryResponseShape>(path);
    const data = resp.data;
    const records: Array<Record<string, unknown>> = data.transactions.map(
      (tx) => ({ ...tx }) as Record<string, unknown>,
    );
    if (data.has_more) {
      const nextOffset = (opts.offset ?? 0) + data.transactions.length;
      records.push({ has_more: true, next_offset: nextOffset });
      if (opts.isTTY) {
        printProgress(`More results: --offset ${nextOffset}`);
      }
    }
    printNdjson(records);
  } catch (err) {
    printError(err);
  }
}
