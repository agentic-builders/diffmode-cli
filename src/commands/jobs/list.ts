import { buildClient } from "../../lib/submit-helpers";
import { printNdjson, printError, printProgress } from "../../lib/output";

interface JobSummary {
  job_id: string;
  status: string;
  product_id?: string | null;
  module_type?: string | null;
  created_at?: string | null;
  user_id?: string | null;
}

interface JobListResponse {
  jobs: JobSummary[];
  total: number;
  next_cursor: string | null;
}

export interface JobsListCommandOptions {
  apiBase?: string;
  token?: string;
  product?: string;
  status?: string;
  limit?: number;
  cursor?: string;
  timeoutMs?: number;
  isTTY?: boolean;
}

export async function jobsListCommand(
  opts: JobsListCommandOptions,
): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const qs = new URLSearchParams();
  if (opts.product) qs.set("product_id", opts.product);
  if (opts.status) qs.set("status", opts.status);
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  const path = qs.toString() ? `/jobs?${qs.toString()}` : "/jobs";

  try {
    const resp = await client.get<JobListResponse>(path);
    const data = resp.data;
    const records: Array<Record<string, unknown>> = data.jobs.map(
      (j) => ({ ...j }) as Record<string, unknown>,
    );
    if (data.next_cursor) {
      records.push({ cursor: data.next_cursor });
      if (opts.isTTY) {
        printProgress(`More results: --cursor ${data.next_cursor}`);
      }
    }
    printNdjson(records);
  } catch (err) {
    printError(err);
  }
}
