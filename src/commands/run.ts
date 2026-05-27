import {
  buildClient,
  resolveFounderInput,
  printSubmitResponse,
  failWith,
  type SubmitCommandResponse,
} from "../lib/submit-helpers";
import { preflightCredits } from "../lib/preflight";
import { resolveBillingUrl } from "../lib/billing-url";

export interface RunCommandOptions {
  product: string;
  apiBase?: string;
  token?: string;
  inputPath?: string;
  fromUrl?: string;
  saveInputPath?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  verbose?: boolean;
  quiet?: boolean;
  cacheEnabled?: boolean;
  skipPreflight?: boolean;
  noPreflight?: boolean;
}

export async function runCommand(opts: RunCommandOptions): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
  });

  try {
    if (!opts.noPreflight) {
      await preflightCredits({
        client,
        action: "run",
        billingUrl: resolveBillingUrl(),
      });
    }
    const founderInput = await resolveFounderInput({
      client,
      ...(opts.inputPath !== undefined ? { inputPath: opts.inputPath } : {}),
      ...(opts.fromUrl !== undefined ? { fromUrl: opts.fromUrl } : {}),
      ...(opts.saveInputPath !== undefined
        ? { saveInputPath: opts.saveInputPath }
        : {}),
      quiet: opts.quiet ?? false,
    });
    const body: Record<string, unknown> = {
      product_id: opts.product,
      founder_input: founderInput,
      cache_enabled: opts.cacheEnabled ?? true,
      skip_preflight: opts.skipPreflight ?? false,
    };
    const resp = await client.post<SubmitCommandResponse>(
      "/free-tier",
      body,
      opts.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : undefined,
    );
    const data = resp.data;
    printSubmitResponse({
      job_id: data.job_id,
      status: data.status,
      module_type: data.module_type ?? "free-tier",
      product_id: data.product_id ?? opts.product,
    });
  } catch (err) {
    failWith(err);
  }
}
