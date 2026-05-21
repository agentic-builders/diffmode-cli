import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { HttpClient, DEFAULT_API_BASE } from "../lib/http";
import { printJson, printError, printProgress } from "../lib/output";
import { UsageError } from "../lib/errors";
import {
  parseFromFile,
  parseFromUrl,
  validateRequired,
  type FounderInputDraft,
} from "../lib/founder-input";

export interface DiagnosticsFromUrlOptions {
  url: string;
  apiBase?: string;
  token?: string;
  save?: string;
  quiet?: boolean;
  timeoutMs?: number;
}

export async function diagnosticsFromUrlCommand(
  opts: DiagnosticsFromUrlOptions,
): Promise<void> {
  const apiBase = opts.apiBase ?? DEFAULT_API_BASE;
  const client = new HttpClient({
    baseUrl: apiBase,
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  let draft: FounderInputDraft;
  try {
    draft = await parseFromUrl(opts.url, {
      client,
      quiet: opts.quiet ?? false,
    });
  } catch (err) {
    printError(err);
  }

  if (opts.save) {
    mkdirSync(dirname(opts.save), { recursive: true });
    writeFileSync(opts.save, JSON.stringify(draft, null, 2), { mode: 0o600 });
    chmodSync(opts.save, 0o600);
    printJson({ saved_to: opts.save, founder_input: draft });
    return;
  }
  printJson({ founder_input: draft });
}

export interface DiagnosticsValidateOptions {
  path: string;
}

export async function diagnosticsValidateCommand(
  opts: DiagnosticsValidateOptions,
): Promise<void> {
  let draft: FounderInputDraft;
  try {
    draft = await parseFromFile(opts.path);
  } catch (err) {
    printError(err);
  }
  const result = validateRequired(draft);
  if (!result.ok) {
    printError(
      new UsageError(
        `Founder input is missing required field(s): ${result.missing.join(", ")}`,
      ),
    );
    return;
  }
  printJson({ valid: true, path: opts.path });
}

export { printProgress };
