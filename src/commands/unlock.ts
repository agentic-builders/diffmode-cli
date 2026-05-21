import {
  buildClient,
  printSubmitResponse,
  failWith,
  type SubmitCommandResponse,
} from "../lib/submit-helpers";
import { UsageError, isDiffmodeError } from "../lib/errors";
import { preflightCredits, MODULE_CREDIT_COSTS } from "../lib/preflight";
import { resolveBillingUrl } from "../lib/billing-url";

export interface UnlockCommandOptions {
  product: string;
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  verbose?: boolean;
  cacheEnabled?: boolean;
  skipPreflight?: boolean;
  noPreflight?: boolean;
}

export async function unlockCommand(opts: UnlockCommandOptions): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
  });

  const body: Record<string, unknown> = {};
  if (opts.cacheEnabled !== undefined) body.cache_enabled = opts.cacheEnabled;
  if (opts.skipPreflight !== undefined) body.skip_preflight = opts.skipPreflight;

  try {
    if (!opts.noPreflight) {
      await preflightCredits({
        client,
        required: MODULE_CREDIT_COSTS["unlock"]!,
        billingUrl: resolveBillingUrl(),
      });
    }
    const resp = await client.post<SubmitCommandResponse>(
      `/products/${encodeURIComponent(opts.product)}/unlock`,
      body,
      opts.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : undefined,
    );
    const data = resp.data;
    printSubmitResponse({
      job_id: data.job_id,
      status: data.status,
      module_type: data.module_type ?? "unlock",
      product_id: data.product_id ?? opts.product,
    });
  } catch (err) {
    // Backend signals "no completed free-tier for this product" with a 404
    // (see ai-cmo-cli/src/api/routes/unlock.py). Translate that into a
    // UsageError with a hint instead of surfacing the raw NotFoundError —
    // this is the documented "run free-tier first" path. Other 422/4xx
    // errors (corrupted result, validation, etc.) flow through unchanged so
    // the agent sees the real server detail.
    if (isDiffmodeError(err) && err.code === "not_found") {
      failWith(
        new UsageError(
          `No prior free-tier report for product '${opts.product}'. Run \`diffmode run ${opts.product}\` first, then \`diffmode unlock ${opts.product}\`.`,
        ),
      );
    }
    failWith(err);
  }
}
