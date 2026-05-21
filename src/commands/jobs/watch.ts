import { buildClient } from "../../lib/submit-helpers";
import {
  printJson,
  printError,
  printProgress,
  writeErrorEnvelope,
  getOutputConfig,
} from "../../lib/output";
import {
  InterruptedResumableError,
  RateLimitedError,
  isDiffmodeError,
} from "../../lib/errors";
import { ExitCode } from "../../lib/exit-codes";
import { computeNextWait, isTerminalStatus } from "../../lib/watch-backoff";
import type { JobStatusPayload } from "./status";

const RESUMABLE_MODULES = new Set(["workflow", "free-tier"]);

// During a multi-hour watch, a single transient blip (NetworkError,
// retryable ServerError) MUST NOT terminate the loop. Allow this many
// consecutive failures before giving up.
const MAX_CONSECUTIVE_FAILURES = 5;

export interface JobsWatchCommandOptions {
  jobId: string;
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  isTTY?: boolean;
  random?: () => number;
  __simulateSigint?: boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitProgress(status: JobStatusPayload, isTTY: boolean): void {
  if (isTTY) {
    let line = `[${status.job_id}] ${status.status}`;
    if (status.progress) {
      const { current_stage, stages_completed, total_stages } = status.progress;
      line += ` stage=${current_stage} (${stages_completed}/${total_stages})`;
    }
    printProgress(line);
  } else {
    if (getOutputConfig().quiet) return;
    const rec: Record<string, unknown> = {
      job_id: status.job_id,
      status: status.status,
    };
    if (status.progress) rec.progress = status.progress;
    process.stderr.write(JSON.stringify(rec) + "\n");
  }
}

// Retry notices share stderr with `emitProgress`. In non-TTY mode stderr is
// machine-parsed line-by-line as NDJSON — emitting plain text via
// `printProgress()` here would corrupt that stream (a single retry breaks any
// JSON parser). TTY mode keeps the human-readable line. `--quiet` silences
// both formats since these are advisory progress, not the terminal payload.
function emitRetryNotice(
  isTTY: boolean,
  jobId: string,
  event: "rate_limited" | "transient_error",
  attempt: number,
  retryAfterSeconds?: number,
): void {
  if (getOutputConfig().quiet) return;
  if (isTTY) {
    const suffix =
      event === "rate_limited"
        ? `Watch: rate-limited polling job ${jobId} (${attempt}/${MAX_CONSECUTIVE_FAILURES})${
            retryAfterSeconds !== undefined
              ? `, retry-after ${retryAfterSeconds}s`
              : ""
          }. Retrying…`
        : `Watch: transient error polling job ${jobId} (${attempt}/${MAX_CONSECUTIVE_FAILURES}). Retrying…`;
    printProgress(suffix);
    return;
  }
  const rec: Record<string, unknown> = {
    job_id: jobId,
    event,
    attempt,
    max_attempts: MAX_CONSECUTIVE_FAILURES,
  };
  if (event === "rate_limited" && retryAfterSeconds !== undefined) {
    rec.retry_after = retryAfterSeconds;
  }
  process.stderr.write(JSON.stringify(rec) + "\n");
}

// Terminal hints (SIGINT resume hint, interrupted-job resume/resubmit hints)
// share stderr with `emitProgress` + `emitRetryNotice`. Non-TTY mode is
// NDJSON line-by-line — plain `printProgress()` here would break any agent
// parsing stderr by line. TTY mode keeps the human-readable phrasing.
// `--quiet` matches `printProgress` semantics: silenced because the hint is
// advisory; the terminal payload (stdout JSON or error envelope) carries the
// machine-readable terminal state regardless.
function emitHint(
  isTTY: boolean,
  jobId: string,
  event: "sigint" | "interrupted_resumable" | "interrupted_not_resumable",
  message: string,
): void {
  if (getOutputConfig().quiet) return;
  if (isTTY) {
    printProgress(message);
    return;
  }
  const rec: Record<string, unknown> = {
    job_id: jobId,
    event,
    hint: message,
  };
  process.stderr.write(JSON.stringify(rec) + "\n");
}

type FetchOutcome =
  | { kind: "ok"; status: JobStatusPayload }
  | { kind: "rate_limited"; error: RateLimitedError }
  | { kind: "transient" };

async function fetchStatus(
  client: ReturnType<typeof buildClient>,
  jobId: string,
): Promise<FetchOutcome> {
  try {
    const resp = await client.get<JobStatusPayload>(
      `/jobs/${encodeURIComponent(jobId)}`,
    );
    return { kind: "ok", status: resp.data };
  } catch (err) {
    // Treat retryable failures (NetworkError, retryable ServerError,
    // RateLimitedError) as soft failures so the watch loop can back off
    // and retry. Non-retryable errors (Auth, NotFound, Usage) escalate.
    if (err instanceof RateLimitedError) {
      return { kind: "rate_limited", error: err };
    }
    if (isDiffmodeError(err) && err.retryable) {
      return { kind: "transient" };
    }
    // Non-retryable: `printError` is declared `never` and exits the process
    // in production. The throw is unreachable there, but makes the contract
    // explicit so a future refactor that loosens `printError`'s return type
    // can't silently let this function return `undefined` and crash the
    // caller's `outcome.kind` access with a confusing TypeError. In tests
    // where `process.exit` is stubbed to throw, this branch is never taken
    // — the test harness escalates the original error first.
    printError(err);
    throw err;
  }
}

export async function jobsWatchCommand(
  opts: JobsWatchCommandOptions,
): Promise<void> {
  const sleep = opts.sleepFn ?? defaultSleep;
  const isTTY = opts.isTTY ?? Boolean(process.stderr.isTTY);
  const started = Date.now();

  // Rebuild the HttpClient each iteration so the per-request AbortController
  // honors the remaining --wait budget. A 60s default per-request timeout
  // would otherwise let a single hung GET /jobs/{id} run far past a short
  // --wait (e.g. `--wait 5s`) before the loop checks the wall-clock deadline.
  const buildIterClient = (): ReturnType<typeof buildClient> => {
    let perRequestTimeoutMs = opts.timeoutMs;
    if (opts.totalTimeoutMs !== undefined) {
      const remaining = opts.totalTimeoutMs - (Date.now() - started);
      // AbortController requires a positive delay; floor at 1ms so a request
      // started right at the deadline aborts on its next event-loop tick
      // instead of waiting the full per-request timeout.
      const clamped = Math.max(remaining, 1);
      perRequestTimeoutMs =
        perRequestTimeoutMs !== undefined
          ? Math.min(perRequestTimeoutMs, clamped)
          : clamped;
    }
    return buildClient({
      ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(perRequestTimeoutMs !== undefined
        ? { timeoutMs: perRequestTimeoutMs }
        : {}),
    });
  };

  let interrupted = Boolean(opts.__simulateSigint);
  const onSigint = (): void => {
    interrupted = true;
  };
  process.once("SIGINT", onSigint);

  // Track failure streaks separately by kind so a single 429 at the end of
  // a transient outage doesn't get misclassified as persistent back-pressure
  // (and vice versa). Exit 7 (rate_limited) only fires after MAX consecutive
  // 429s; exit 3 (network) only after MAX consecutive transient errors.
  let consecutiveRateLimits = 0;
  let consecutiveTransient = 0;
  let lastRateLimit: RateLimitedError | null = null;

  const exitOnTotalTimeout = (): never => {
    // Client-side watch deadline. NOT a server rate-limit (exit 7 with
    // code "rate_limited" promises a `retry_after` an agent should
    // honor — we don't have one). Surface as GENERIC so agents don't
    // misclassify this as back-pressure.
    writeErrorEnvelope({
      code: "generic",
      message: `Timed out waiting for job ${opts.jobId} after ${opts.totalTimeoutMs}ms; job still running. Re-watch with \`diffmode jobs watch ${opts.jobId}\`.`,
      retryable: false,
      job_id: opts.jobId,
    });
    process.exit(ExitCode.GENERIC);
  };

  const deadlineReached = (): boolean =>
    opts.totalTimeoutMs !== undefined &&
    Date.now() - started >= opts.totalTimeoutMs;

  // Cap a planned sleep to whatever wall-clock budget remains so we never
  // overshoot --wait while honoring a Retry-After or a transient backoff.
  const clampToRemaining = (waitMs: number): number => {
    if (opts.totalTimeoutMs === undefined) return waitMs;
    const remaining = opts.totalTimeoutMs - (Date.now() - started);
    if (remaining <= 0) return 0;
    return Math.min(waitMs, remaining);
  };

  try {
    while (!interrupted) {
      // Check the wall-clock deadline FIRST so retry-branch sleeps (rate
      // limit / transient) can't push the watch past --wait. The post-status
      // emit-progress branch also benefits from the same single chokepoint.
      if (deadlineReached()) exitOnTotalTimeout();

      const outcome = await fetchStatus(buildIterClient(), opts.jobId);

      if (outcome.kind !== "ok") {
        if (outcome.kind === "rate_limited") {
          consecutiveRateLimits += 1;
          consecutiveTransient = 0;
          lastRateLimit = outcome.error;
        } else {
          consecutiveTransient += 1;
          consecutiveRateLimits = 0;
          lastRateLimit = null;
        }
        if (
          consecutiveRateLimits >= MAX_CONSECUTIVE_FAILURES &&
          lastRateLimit
        ) {
          // Persistent 429s are back-pressure from the server, NOT a
          // network blip. Surface as code "rate_limited" + exit 7 so
          // agents honor Retry-After per the documented exit contract.
          writeErrorEnvelope({
            code: "rate_limited",
            message: `Watch aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive rate-limit responses polling job ${opts.jobId}.`,
            retryable: true,
            ...(lastRateLimit.retry_after !== undefined
              ? { retry_after: lastRateLimit.retry_after }
              : {}),
          });
          process.exit(ExitCode.RATE_LIMITED);
        }
        if (consecutiveTransient >= MAX_CONSECUTIVE_FAILURES) {
          writeErrorEnvelope({
            code: "network",
            message: `Watch aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive transient errors polling job ${opts.jobId}.`,
            retryable: true,
          });
          process.exit(ExitCode.NETWORK);
        }
        if (outcome.kind === "rate_limited") {
          const retryAfter = outcome.error.retry_after;
          emitRetryNotice(
            isTTY,
            opts.jobId,
            "rate_limited",
            consecutiveRateLimits,
            retryAfter,
          );
          const hintMs =
            retryAfter !== undefined && retryAfter > 0
              ? retryAfter * 1000
              : undefined;
          const waitMs = computeNextWait(
            hintMs,
            opts.random ? { random: opts.random } : {},
          );
          await sleep(clampToRemaining(waitMs));
          continue;
        }
        emitRetryNotice(
          isTTY,
          opts.jobId,
          "transient_error",
          consecutiveTransient,
        );
        const waitMs = computeNextWait(
          undefined,
          opts.random ? { random: opts.random } : {},
        );
        await sleep(clampToRemaining(waitMs));
        continue;
      }
      consecutiveRateLimits = 0;
      consecutiveTransient = 0;
      lastRateLimit = null;
      const status = outcome.status;

      if (isTerminalStatus(status.status)) {
        handleTerminal(status, isTTY);
      }

      emitProgress(status, isTTY);

      if (deadlineReached()) exitOnTotalTimeout();

      const waitMs = computeNextWait(
        status.next_poll_ms,
        opts.random ? { random: opts.random } : {},
      );
      await sleep(clampToRemaining(waitMs));

      if (opts.__simulateSigint) interrupted = true;
    }

    if (interrupted) {
      emitHint(
        isTTY,
        opts.jobId,
        "sigint",
        `Job ${opts.jobId} still running. Resume watch with: \`diffmode jobs watch ${opts.jobId}\``,
      );
      process.exit(ExitCode.SIGINT);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function handleTerminal(status: JobStatusPayload, isTTY: boolean): never {
  printJson(status as unknown as Record<string, unknown>);

  if (status.status === "completed") {
    process.exit(ExitCode.OK);
  }
  if (status.status === "interrupted") {
    const moduleType = status.module_type ?? "";
    if (RESUMABLE_MODULES.has(moduleType)) {
      emitHint(
        isTTY,
        status.job_id,
        "interrupted_resumable",
        `Hint: job interrupted. Run \`diffmode jobs resume ${status.job_id}\` to resume.`,
      );
      const err = new InterruptedResumableError(
        `Job ${status.job_id} interrupted (resumable: ${moduleType})`,
        status.job_id,
      );
      writeErrorEnvelope(err.toJSON() as unknown as Record<string, unknown>);
      process.exit(ExitCode.INTERRUPTED_RESUMABLE);
    } else {
      const productId = status.product_id ?? "<product>";
      const moduleLabel = moduleType || "<module>";
      emitHint(
        isTTY,
        status.job_id,
        "interrupted_not_resumable",
        `Hint: ${moduleLabel} is not resumable. Resubmit with \`diffmode ${moduleLabel} ${productId}\`.`,
      );
      const err = new InterruptedResumableError(
        `Job ${status.job_id} interrupted (${moduleLabel} is not resumable; resubmit)`,
        status.job_id,
      );
      writeErrorEnvelope(err.toJSON() as unknown as Record<string, unknown>);
      process.exit(ExitCode.INTERRUPTED_RESUMABLE);
    }
  }
  if (status.status === "cancelled") {
    writeErrorEnvelope({
      code: "generic",
      message: `Job ${status.job_id} was cancelled.`,
      retryable: false,
      job_id: status.job_id,
    });
    process.exit(ExitCode.GENERIC);
  }
  if (status.status === "failed") {
    writeErrorEnvelope({
      code: "generic",
      message:
        status.error ??
        `Job ${status.job_id} failed without a server-provided reason.`,
      retryable: false,
      job_id: status.job_id,
    });
    process.exit(ExitCode.GENERIC);
  }
  // Fallback: any other unexpected terminal status — emit an envelope so
  // agents always see a structured failure rather than a silent exit.
  writeErrorEnvelope({
    code: "generic",
    message: `Job ${status.job_id} reached unexpected terminal status: ${status.status}`,
    retryable: false,
    job_id: status.job_id,
  });
  process.exit(ExitCode.GENERIC);
}
