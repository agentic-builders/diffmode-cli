import { readFileSync, existsSync } from "node:fs";
import {
  buildClient,
  printSubmitResponse,
  failWith,
  type SubmitCommandResponse,
} from "../lib/submit-helpers";
import { UsageError } from "../lib/errors";
import { preflightCredits } from "../lib/preflight";
import { resolveBillingUrl } from "../lib/billing-url";

export interface IdeaInputPayload {
  name: string;
  description: string;
  target_customer?: string;
  problem?: string;
  solution?: string;
  revenue_model?: string;
  price_point?: string;
  revenue_goal_min?: string;
  revenue_goal_ambitious?: string;
  validation?: string;
  [key: string]: unknown;
}

export interface IdeaEvalCommandOptions {
  product: string;
  apiBase?: string;
  token?: string;
  ideasFile: string;
  intuition?: string;
  targetIdea?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  verbose?: boolean;
  cacheEnabled?: boolean;
  skipPreflight?: boolean;
  noPreflight?: boolean;
}

export function parseIdeasFile(path: string): IdeaInputPayload[] {
  if (!existsSync(path)) {
    throw new UsageError(`Ideas file not found: ${path}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new UsageError(
      `Failed to read ideas file ${path}: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `Invalid JSON in ideas file (${path}): ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new UsageError(
      `Ideas file must contain a JSON array of IdeaInput objects (got ${typeof parsed === "object" && parsed !== null ? "object" : typeof parsed}). See skills/diffmode/references/idea-input-schema.md`,
    );
  }
  if (parsed.length === 0) {
    throw new UsageError("Ideas file must contain at least one idea.");
  }
  const out: IdeaInputPayload[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new UsageError(
        `Ideas[${i}] must be an object with at least { name, description }.`,
      );
    }
    const rec = item as Record<string, unknown>;
    const name = rec["name"];
    const description = rec["description"];
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new UsageError(
        `Ideas[${i}] is missing required field \`name\` (non-empty string).`,
      );
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      throw new UsageError(
        `Ideas[${i}] is missing required field \`description\` (non-empty string).`,
      );
    }
    out.push(rec as IdeaInputPayload);
  }
  return out;
}

export async function ideaEvalCommand(
  opts: IdeaEvalCommandOptions,
): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
  });

  try {
    const ideas = parseIdeasFile(opts.ideasFile);
    if (!opts.noPreflight) {
      await preflightCredits({
        client,
        action: "idea-eval",
        billingUrl: resolveBillingUrl(),
      });
    }
    const body: Record<string, unknown> = {
      product_id: opts.product,
      ideas,
      cache_enabled: opts.cacheEnabled ?? true,
      skip_preflight: opts.skipPreflight ?? false,
    };
    if (opts.intuition !== undefined) body.intuition = opts.intuition;
    if (opts.targetIdea !== undefined) body.target_idea = opts.targetIdea;

    const resp = await client.post<SubmitCommandResponse>(
      "/idea-eval",
      body,
      opts.idempotencyKey !== undefined
        ? { idempotencyKey: opts.idempotencyKey }
        : undefined,
    );
    const data = resp.data;
    printSubmitResponse({
      job_id: data.job_id,
      status: data.status,
      module_type: data.module_type ?? "idea-eval",
      product_id: data.product_id ?? opts.product,
    });
  } catch (err) {
    failWith(err);
  }
}
