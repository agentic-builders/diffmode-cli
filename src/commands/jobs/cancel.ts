import { buildClient } from "../../lib/submit-helpers";
import { printJson, printError } from "../../lib/output";
import { UsageError } from "../../lib/errors";

export interface JobsCancelCommandOptions {
  jobId: string;
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
  yes?: boolean;
  confirmFn?: () => Promise<boolean>;
}

async function defaultConfirm(jobId: string): Promise<boolean> {
  process.stderr.write(`Cancel job ${jobId}? [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    let buffer = "";
    const cleanup = (): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl !== -1) {
        cleanup();
        resolve(buffer.slice(0, nl).trim());
      }
    };
    // Without an 'end' listener, Ctrl-D / closed stdin would never resolve
    // the promise — the CLI would hang indefinitely. Treat EOF as "no".
    const onEnd = (): void => {
      cleanup();
      resolve(buffer.trim());
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
  return /^y(es)?$/i.test(answer);
}

export async function jobsCancelCommand(
  opts: JobsCancelCommandOptions,
): Promise<void> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // Ask for confirmation when stdin is interactive (unless --yes). Gating
  // on stdin (not stdout) means `diffmode jobs cancel <id> --json | jq ...`
  // still prompts the user — piping stdout doesn't imply the user wants to
  // skip the safety check.
  if (!opts.yes && process.stdin.isTTY) {
    const confirm = opts.confirmFn ?? (() => defaultConfirm(opts.jobId));
    const ok = await confirm();
    if (!ok) {
      printError(new UsageError("Cancellation aborted by user."));
    }
  }

  try {
    await client.delete(`/jobs/${encodeURIComponent(opts.jobId)}`);
    printJson({ cancelled: true, job_id: opts.jobId });
  } catch (err) {
    printError(err);
  }
}
