import { DiffmodeError, isDiffmodeError } from "./errors";
import { ExitCode } from "./exit-codes";

export const SCHEMA_VERSION = "1";

export interface OutputConfig {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
  isTTY: boolean;
}

const DEFAULT_CONFIG: OutputConfig = {
  json: false,
  quiet: false,
  verbose: false,
  noColor: false,
  isTTY: Boolean(process.stdout.isTTY),
};

let currentConfig: OutputConfig = { ...DEFAULT_CONFIG };

export function setOutputConfig(patch: Partial<OutputConfig>): void {
  currentConfig = { ...currentConfig, ...patch };
}

export function resetOutputConfig(): void {
  currentConfig = {
    ...DEFAULT_CONFIG,
    isTTY: Boolean(process.stdout.isTTY),
  };
}

export function getOutputConfig(): OutputConfig {
  return currentConfig;
}

export function shouldEmitJson(): boolean {
  if (currentConfig.json) return true;
  if (!currentConfig.isTTY) return true;
  return false;
}

export function printJson(data: Record<string, unknown>): void {
  // schema_version is the CLI's contract — never echo back whatever value the
  // server (or any other caller) happens to put in `data`. Spread first, then
  // overwrite, so the CLI's value always wins. Without this, a server payload
  // that grows its own `schema_version` field would silently bypass the
  // CLI's stable version pin and break agents that gate on `schema_version`.
  const payload = { ...data, schema_version: SCHEMA_VERSION };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

export function printNdjson(records: Array<Record<string, unknown>>): void {
  for (const record of records) {
    process.stdout.write(JSON.stringify(record) + "\n");
  }
}

export function printProgress(line: string): void {
  if (currentConfig.quiet) return;
  process.stderr.write(line + "\n");
}

export function writeErrorEnvelope(error: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ schema_version: SCHEMA_VERSION, error }) + "\n",
  );
}

export function printError(err: unknown): never {
  let errorBody: Record<string, unknown>;
  let exitCode: number;

  if (isDiffmodeError(err)) {
    errorBody = (err as DiffmodeError).toJSON() as unknown as Record<
      string,
      unknown
    >;
    exitCode = err.exitCode;
  } else if (err instanceof Error) {
    errorBody = {
      code: "generic",
      message: err.message,
      retryable: false,
    };
    exitCode = ExitCode.GENERIC;
  } else {
    errorBody = {
      code: "generic",
      message: String(err),
      retryable: false,
    };
    exitCode = ExitCode.GENERIC;
  }

  process.stderr.write(
    JSON.stringify({ schema_version: SCHEMA_VERSION, error: errorBody }) + "\n",
  );
  process.exit(exitCode);
}
