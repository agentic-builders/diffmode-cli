import { HttpClient, type HttpClientOptions } from "./http";
import { UsageError } from "./errors";
import { printError, printJson } from "./output";
import { resolveBillingUrl } from "./billing-url";
import {
  parseFromFile,
  parseFromUrl,
  mergeInputs,
  validateRequired,
  type FounderInputDraft,
} from "./founder-input";

export interface SubmitCommandResponse {
  job_id: string;
  status: string;
  module_type?: string;
  product_id?: string;
  detail?: string;
}

export interface BuildClientArgs {
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
  verbose?: boolean;
}

export function buildClient(args: BuildClientArgs): HttpClient {
  const opts: HttpClientOptions = {};
  if (args.apiBase !== undefined) opts.baseUrl = args.apiBase;
  if (args.token !== undefined) opts.token = args.token;
  if (args.timeoutMs !== undefined) opts.timeoutMs = args.timeoutMs;
  if (args.verbose !== undefined) opts.verbose = args.verbose;
  // Always thread the resolved billing URL into the client so that a server
  // 402 (race window after pre-flight, or `--no-preflight`) surfaces the
  // env-overridden URL, not the hardcoded default.
  opts.billingUrl = resolveBillingUrl();
  return new HttpClient(opts);
}

export interface FounderInputResolveArgs {
  client: HttpClient;
  inputPath?: string;
  fromUrl?: string;
  saveInputPath?: string;
  quiet?: boolean;
}

export async function resolveFounderInput(
  args: FounderInputResolveArgs,
): Promise<FounderInputDraft> {
  let fromFile: FounderInputDraft | undefined;
  let fromUrl: FounderInputDraft | undefined;

  if (args.inputPath) {
    fromFile = await parseFromFile(args.inputPath);
  }
  if (args.fromUrl) {
    fromUrl = await parseFromUrl(args.fromUrl, {
      client: args.client,
      quiet: args.quiet ?? false,
    });
  }
  if (!fromFile && !fromUrl) {
    throw new UsageError(
      "Founder input required. Pass --input <file|-> or --from-url <url>. Interactive gap-fill (TTY) is not implemented in 0.1.0.",
    );
  }
  const merged = mergeInputs(fromFile, fromUrl);
  const validation = validateRequired(merged);
  if (!validation.ok) {
    throw new UsageError(
      `Founder input is missing required field(s): ${validation.missing.join(", ")}. See skills/diffmode/references/founder-input-schema.md`,
    );
  }
  if (args.saveInputPath) {
    const { writeFileSync, mkdirSync, chmodSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(args.saveInputPath), { recursive: true });
    writeFileSync(args.saveInputPath, JSON.stringify(merged, null, 2), {
      mode: 0o600,
    });
    chmodSync(args.saveInputPath, 0o600);
  }
  return merged;
}

export function printSubmitResponse(resp: SubmitCommandResponse): void {
  const out: Record<string, unknown> = {
    job_id: resp.job_id,
    status: resp.status,
  };
  if (resp.module_type) out.module_type = resp.module_type;
  if (resp.product_id) out.product_id = resp.product_id;
  if (resp.detail) out.detail = resp.detail;
  printJson(out);
}

export function failWith(err: unknown): never {
  printError(err);
}
