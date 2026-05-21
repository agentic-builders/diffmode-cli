import { buildClient } from "../../lib/submit-helpers";
import { printJson, printError } from "../../lib/output";

export interface JobStatusPayload {
  job_id: string;
  status: string;
  module_type?: string;
  product_id?: string;
  created_at?: string;
  next_poll_ms?: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
  progress?: {
    current_stage: string;
    stages_completed: number;
    total_stages: number;
    current_stage_started_at?: string | null;
  } | null;
}

export interface JobsStatusCommandOptions {
  jobId: string;
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
}

export async function jobsStatusCommand(
  opts: JobsStatusCommandOptions,
): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  try {
    const resp = await client.get<JobStatusPayload>(
      `/jobs/${encodeURIComponent(opts.jobId)}`,
    );
    printJson(resp.data as unknown as Record<string, unknown>);
  } catch (err) {
    printError(err);
  }
}
