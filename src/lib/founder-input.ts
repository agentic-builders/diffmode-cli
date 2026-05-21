import { readFileSync, existsSync } from "node:fs";
import { HttpClient } from "./http";
import { UsageError } from "./errors";

/**
 * FounderDiagnostics draft — mirrors `ai-cmo-cli/src/api/models.py:FounderDiagnostics`.
 *
 * Only `product_description` is hard-required server-side; every other
 * declared field defaults to "" or None. `extra="allow"` semantics are
 * preserved here as an index signature on the type.
 *
 * The canonical schema lives in the backend Python; this type is a
 * structural mirror. Regenerate the docs under
 * `skills/diffmode/references/founder-input-schema.md` when the
 * `FounderDiagnostics` Pydantic class changes.
 */
export interface FounderInputDraft {
  product_description?: string;
  pricing?: string;
  target_audience?: string;
  trigger_events?: string;
  alternatives_used?: string;
  product_complexity?: { type?: string; details?: string } | null;
  current_growth?: Record<string, unknown> | null;
  challenges?: Record<string, unknown> | null;
  acquisition_sources?: string;
  marketing_experiments?: string;
  resource_constraints?: Record<string, unknown> | null;
  tactics_ruled_out?: string;
  goals?: string;
  budget?: string;
  problem_urgency?: Record<string, unknown> | null;
  trigger_events_source?: string;
  observed_customers?: string;
  business_model?: string;
  retention_signal?: string;
  emotional_signals?: string;
  blind_spots?: string;
  persona_type?: string;
  current_mrr?: string;
  funding_stage?: string;
  team_size?: string;
  your_role?: string;
  what_makes_you_different?: string;
  marketing_team_size?: string;
  top_competitors?: string;
  channels_tried_raw?: string | string[];
  customer_mix?: string;
  comprehension_friction?: string;
  resource_profile?: string;
  comfortable_with_outreach?: "" | "yes" | "no";
  // extra="allow" — additional fields pass through
  [key: string]: unknown;
}

// Mirrors backend `_RESERVED_FOUNDER_KEYS` in
// `ai-cmo-cli/src/api/routes/free_tier.py` ({product_id, user_id,
// module_type}) plus a few defensive extras (created_at/updated_at/id/job_id)
// the backend would silently tunnel through `extra="allow"` but that have no
// legitimate caller use.
const RESERVED_KEYS = new Set([
  "user_id",
  "created_at",
  "updated_at",
  "id",
  "job_id",
  "product_id",
  "module_type",
]);

const REQUIRED_FIELDS = ["product_description"] as const;

const RECOMMENDED_OPTIONAL_FIELDS = [
  "target_audience",
  "trigger_events",
  "pricing",
  "current_growth",
  "acquisition_sources",
] as const;

export interface ParseFromFileOptions {
  readStdin?: () => Promise<string>;
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function parseFromFile(
  path: string,
  opts: ParseFromFileOptions = {},
): Promise<FounderInputDraft> {
  let raw: string;
  if (path === "-") {
    const reader = opts.readStdin ?? defaultReadStdin;
    raw = await reader();
  } else {
    if (!existsSync(path)) {
      throw new UsageError(`Input file not found: ${path}`);
    }
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      throw new UsageError(
        `Failed to read input file ${path}: ${(err as Error).message}`,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(
      `Invalid JSON in founder input (${path}): ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(
      `Founder input must be a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (RESERVED_KEYS.has(key)) {
      throw new UsageError(
        `Reserved key in founder input: \`${key}\`. The server populates this field; remove it from your input file.`,
      );
    }
  }

  return obj as FounderInputDraft;
}

interface WebsiteAnalysisResponse {
  company_name?: string;
  company_description?: string;
  product_type?: string;
  analysis_pricing?: string;
  target_customer?: string;
  analysis_trigger_events?: string;
  top_competitors?: string;
  what_makes_you_different?: string;
  how_customers_find_you_today?: string;
  analysis_product_complexity_type?: string;
  analysis_product_complexity_details?: string;
  source_url?: string;
  auto_filled_fields?: string[];
  draft_fields?: string[];
}

export interface ParseFromUrlOptions {
  client: HttpClient;
  quiet?: boolean;
  warnFn?: (line: string) => void;
}

function defaultWarn(line: string): void {
  process.stderr.write(line + "\n");
}

export async function parseFromUrl(
  url: string,
  opts: ParseFromUrlOptions,
): Promise<FounderInputDraft> {
  const response = await opts.client.post<WebsiteAnalysisResponse>(
    "/analyze-website",
    { url },
  );
  const data = response.data;

  const out: FounderInputDraft = {};
  if (data.company_description) out.product_description = data.company_description;
  if (data.analysis_pricing) out.pricing = data.analysis_pricing;
  if (data.target_customer) out.target_audience = data.target_customer;
  if (data.analysis_trigger_events)
    out.trigger_events = data.analysis_trigger_events;
  if (data.how_customers_find_you_today)
    out.acquisition_sources = data.how_customers_find_you_today;
  if (data.top_competitors) out.top_competitors = data.top_competitors;
  if (data.what_makes_you_different)
    out.what_makes_you_different = data.what_makes_you_different;

  const complexityType = data.analysis_product_complexity_type;
  const complexityDetails = data.analysis_product_complexity_details;
  if (
    (complexityType && complexityType.length > 0) ||
    (complexityDetails && complexityDetails.length > 0)
  ) {
    out.product_complexity = {
      ...(complexityType ? { type: complexityType } : {}),
      ...(complexityDetails ? { details: complexityDetails } : {}),
    };
  }

  if (!opts.quiet) {
    const warn = opts.warnFn ?? defaultWarn;
    const auto = data.auto_filled_fields ?? [];
    const draft = data.draft_fields ?? [];
    if (auto.length > 0) {
      warn(`Auto-filled from URL: ${auto.join(", ")}`);
    }
    if (draft.length > 0) {
      warn(`Draft (best-guess) fields — review before submit: ${draft.join(", ")}`);
    }
  }

  return out;
}

export function mergeInputs(
  fromFile: FounderInputDraft | undefined,
  fromUrl: FounderInputDraft | undefined,
): FounderInputDraft {
  if (!fromFile && !fromUrl) return {};
  if (!fromFile) return { ...fromUrl };
  if (!fromUrl) return { ...fromFile };

  const merged: FounderInputDraft = { ...fromUrl };
  for (const [k, v] of Object.entries(fromFile)) {
    // Empty strings from file do NOT clobber url-provided values.
    if (typeof v === "string" && v.length === 0) continue;
    if (v === null || v === undefined) continue;
    (merged as Record<string, unknown>)[k] = v;
  }
  return merged;
}

export type RequiredValidationResult =
  | { ok: true }
  | { ok: false; missing: string[] };

export function validateRequired(
  input: FounderInputDraft,
): RequiredValidationResult {
  const missing: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push(field);
    }
  }
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}

export function recommendedOptionalGaps(
  input: FounderInputDraft,
): string[] {
  const gaps: string[] = [];
  for (const field of RECOMMENDED_OPTIONAL_FIELDS) {
    const value = input[field];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0);
    if (empty) gaps.push(field);
  }
  return gaps;
}

export type Prompter = (
  key: string,
  meta: { required: boolean; label: string },
) => Promise<string>;

export interface FillGapsOptions {
  prompt: Prompter;
  ttyAssert?: () => boolean;
}

export interface FillGapsSpec {
  required: string[];
  optional: string[];
}

export async function fillGapsInteractive(
  input: FounderInputDraft,
  spec: FillGapsSpec,
  opts: FillGapsOptions,
): Promise<FounderInputDraft> {
  const assertTty =
    opts.ttyAssert ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (!assertTty()) {
    throw new UsageError(
      "Interactive gap-fill requires a TTY. Provide a complete `--input <file>` or `--from-url <url>` instead.",
    );
  }

  const out: FounderInputDraft = { ...input };
  for (const key of spec.required) {
    const existing = out[key];
    const hasValue =
      typeof existing === "string"
        ? existing.trim().length > 0
        : existing !== undefined && existing !== null;
    if (hasValue) continue;
    const answer = (
      await opts.prompt(key, { required: true, label: humanLabel(key) })
    ).trim();
    if (answer.length === 0) {
      throw new UsageError(
        `Required field \`${key}\` was not provided. Re-run with \`--input <file>\` or supply a value.`,
      );
    }
    out[key] = answer;
  }
  for (const key of spec.optional) {
    const existing = out[key];
    const hasValue =
      typeof existing === "string"
        ? existing.trim().length > 0
        : existing !== undefined && existing !== null;
    if (hasValue) continue;
    const answer = (
      await opts.prompt(key, { required: false, label: humanLabel(key) })
    ).trim();
    if (answer.length === 0) continue; // user opted to skip
    out[key] = answer;
  }
  return out;
}

function humanLabel(key: string): string {
  return key
    .split("_")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : ""))
    .join(" ");
}

export const FOUNDER_INPUT_REQUIRED_FIELDS: readonly string[] = REQUIRED_FIELDS;
export const FOUNDER_INPUT_RECOMMENDED_OPTIONAL_FIELDS: readonly string[] =
  RECOMMENDED_OPTIONAL_FIELDS;
