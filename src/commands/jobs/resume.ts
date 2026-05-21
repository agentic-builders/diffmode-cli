import {
  buildClient,
  printSubmitResponse,
  type SubmitCommandResponse,
} from "../../lib/submit-helpers";
import { UsageError } from "../../lib/errors";
import { printError } from "../../lib/output";
import type { JobStatusPayload } from "./status";

const RESUMABLE_MODULES = new Set(["workflow", "free-tier"]);

export interface JobsResumeCommandOptions {
  jobId: string;
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export async function jobsResumeCommand(
  opts: JobsResumeCommandOptions,
): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const idemOpts =
    opts.idempotencyKey !== undefined
      ? { idempotencyKey: opts.idempotencyKey }
      : undefined;

  try {
    const statusResp = await client.get<JobStatusPayload>(
      `/jobs/${encodeURIComponent(opts.jobId)}`,
    );
    const moduleType = statusResp.data.module_type ?? "";
    const productId = statusResp.data.product_id ?? "";

    if (!RESUMABLE_MODULES.has(moduleType)) {
      throw new UsageError(
        `Module \`${moduleType}\` is not resumable; resubmit with \`diffmode ${moduleType} ${productId || "<product>"}\` instead.`,
      );
    }

    if (moduleType === "free-tier") {
      if (!productId) {
        throw new UsageError(
          `Cannot resume free-tier job ${opts.jobId}: status response missing \`product_id\`.`,
        );
      }
      const resp = await client.post<SubmitCommandResponse>(
        `/free-tier/${encodeURIComponent(productId)}/retry`,
        {},
        idemOpts,
      );
      printSubmitResponse({
        job_id: resp.data.job_id,
        status: resp.data.status,
        module_type: resp.data.module_type ?? "free-tier",
        product_id: resp.data.product_id ?? productId,
      });
      return;
    }
    // workflow
    if (!productId) {
      throw new UsageError(
        `Cannot resume workflow job ${opts.jobId}: status response missing \`product_id\`.`,
      );
    }
    const resp = await client.post<SubmitCommandResponse>(
      "/workflow/resume",
      { product_id: productId },
      idemOpts,
    );
    printSubmitResponse({
      job_id: resp.data.job_id,
      status: resp.data.status,
      module_type: resp.data.module_type ?? "workflow",
      product_id: resp.data.product_id ?? productId,
    });
  } catch (err) {
    printError(err);
  }
}
