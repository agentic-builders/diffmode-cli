import { existsSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { buildClient } from "../lib/submit-helpers";
import {
  resolveLatestCompletedJob,
  downloadProductOutputs,
  downloadProductReport,
  defaultOutDir,
  readLocalFile,
  type DownloadResult,
} from "../lib/artifacts";
import {
  printJson,
  printError,
  printProgress,
  getOutputConfig,
} from "../lib/output";
import { NotFoundError, UsageError } from "../lib/errors";

const TOKEN_CHARS_RATIO = 4; // approximation: 1 token ≈ 4 chars

export interface ResultsCommandOptions {
  product: string;
  apiBase?: string;
  token?: string;
  timeoutMs?: number;
  jobId?: string;
  out?: string;
  outBase?: string;
  summary?: boolean;
  show?: string;
  maxTokens?: number;
  pull?: boolean;
  stage?: string;
  tactic?: string;
}

interface ResolvedManifest {
  outDir: string;
  jobId: string;
  moduleType: string;
  download: DownloadResult;
  report: Record<string, unknown> | null;
  // Set when --job-id is pinned to a job that's not the latest completed
  // run for this product. Surfaced in every JSON output mode (manifest,
  // --summary, --stage, --tactic) so agents detect drift even when --quiet
  // suppresses the stderr progress note. For cat-style modes (--pull,
  // --show) the caller emits drift to stderr regardless of --quiet.
  latestCompletedJobId?: string;
  // True when --job-id was pinned and the advisory drift lookup failed
  // (transient 429/5xx/network). We cannot tell whether the pinned job is
  // still current — files reflect the current product workspace which may
  // or may not match the pinned manifest. Surfaced so agents/humans see
  // the integrity unknown even on the best-effort advisory failure path.
  driftLookupFailed?: boolean;
}

// Server-derived `job_id` flows into the on-disk destination via `pickOutDir`
// → `defaultOutDir` → `path.join`. `path.resolve()` would normalise `..`
// segments and let a hostile/buggy server response steer the destination
// outside `.diffmode/<product>/`. The subsequent `rmSync(outDir, …)` in the
// drift-quarantine branch would then delete that arbitrary path. Reject any
// `job_id` that contains a separator, `..`, or other unsafe characters before
// it reaches the filesystem. UUIDs and the server's documented id shapes
// remain valid.
function assertSafeJobId(jobId: string): void {
  if (
    jobId === "" ||
    jobId === "." ||
    jobId === ".." ||
    jobId.includes("/") ||
    jobId.includes("\\") ||
    jobId.includes("\0") ||
    /(^|[/\\])\.\.([/\\]|$)/.test(jobId)
  ) {
    throw new UsageError(
      `Refusing to use job_id '${jobId}' as a filesystem path segment.`,
    );
  }
}

function pickOutDir(opts: ResultsCommandOptions, jobId: string): string {
  // `--out <dir>` is user-explicit ownership of the destination, so it is
  // honored verbatim — the auto-redirect (to `<latest-job>/`) and the advisory
  // quarantine (`<pinned>-unverified/`) that protect the default and
  // `--out-base` paths from clobbering a prior snapshot do NOT apply here.
  // The drift warning text on this path acknowledges that — see
  // `driftMessageOutExplicit` / `driftUnknownMessageOutExplicit` — so the user
  // can manually verify the destination didn't conflict with a real snapshot.
  if (opts.out) return resolvePath(opts.out);
  assertSafeJobId(jobId);
  if (opts.outBase) {
    return resolvePath(opts.outBase, opts.product, jobId);
  }
  return resolvePath(defaultOutDir(opts.product, jobId));
}

function reportSections(report: Record<string, unknown> | null): string[] {
  if (!report || typeof report !== "object") return [];
  return Object.keys(report);
}

async function resolveAndDownload(
  opts: ResultsCommandOptions,
): Promise<ResolvedManifest> {
  const client = buildClient({
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.token !== undefined ? { token: opts.token } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const info = await resolveLatestCompletedJob({
    client,
    product: opts.product,
    ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
  });
  if (!info) {
    throw new NotFoundError(
      `No completed jobs found for product '${opts.product}'. Run \`diffmode run ${opts.product}\` first.`,
    );
  }

  // Phase 1: `/products/{id}/outputs` returns the current product workspace
  // — outputs are not job-scoped. When the user pinned `--job-id`, detect
  // drift if that job is not the latest completed run for this product,
  // since the downloaded files will reflect whatever ran most recently, not
  // the pinned job. Per-job snapshots arrive with the Phase 2 manifest
  // endpoint. The lookup is advisory: a transient failure (429/5xx/network)
  // must not abort the download — agents calling `results --job-id` expect
  // the artifacts, not a hard failure on missing drift metadata. The caller
  // (`resultsCommand`) decides how to surface drift per output mode.
  let latestCompletedJobId: string | undefined;
  let driftLookupFailed = false;
  if (opts.jobId !== undefined) {
    try {
      const latest = await resolveLatestCompletedJob({
        client,
        product: opts.product,
      });
      if (latest && latest.job_id !== info.job_id) {
        latestCompletedJobId = latest.job_id;
      }
    } catch {
      // Advisory lookup only — swallow failures so transient API blips don't
      // turn a healthy `results --job-id` download into a command-level error.
      driftLookupFailed = true;
    }
  }

  // When drift is detected, redirect the local snapshot dir to the latest
  // completed job's id — the files actually come from that run, not the
  // pinned job. Writing them into `<pinned-job>/` would silently overwrite
  // a prior snapshot the user may still rely on. The manifest's `job_id`
  // still reflects the pin; `out_dir` and `latest_completed_job_id`
  // together tell the agent where the files landed and why.
  //
  // When the advisory drift lookup failed we cannot confirm whether the
  // workspace matches the pinned job — same overwrite risk applies, so
  // quarantine the snapshot under `<pinned-job>-unverified/` instead of
  // writing into `<pinned-job>/` blind. The pinned snapshot (if any) is
  // left untouched; `drift_lookup_failed` + the stderr warning tell the
  // agent why the path moved.
  const writeJobId =
    latestCompletedJobId ??
    (driftLookupFailed ? `${info.job_id}-unverified` : info.job_id);
  const outDir = pickOutDir(opts, writeJobId);
  // Clean the quarantine dir before writing so two consecutive advisory
  // failures don't merge into a mixed snapshot. `downloadProductOutputs`
  // writes/skips files present in the payload but never prunes files
  // that disappeared between pulls — without this, a stale file from
  // call 1 plus updated files from call 2 would coexist in
  // `<pinned>-unverified/`, defeating the per-pull quarantine semantic.
  // Only safe when `pickOutDir` actually appended the suffix — `--out`
  // is user-owned and bypasses the auto-quarantine path entirely.
  if (driftLookupFailed && opts.out === undefined && existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  const download = await downloadProductOutputs({
    client,
    product: opts.product,
    outDir,
  });

  let report: Record<string, unknown> | null = null;
  if (info.module_type === "free-tier") {
    report = await downloadProductReport({ client, product: opts.product });
  }

  return {
    outDir,
    jobId: info.job_id,
    moduleType: info.module_type,
    download,
    report,
    ...(latestCompletedJobId !== undefined ? { latestCompletedJobId } : {}),
    ...(driftLookupFailed ? { driftLookupFailed: true } : {}),
  };
}

function emitManifest(opts: ResultsCommandOptions, m: ResolvedManifest): void {
  const out: Record<string, unknown> = {
    product: opts.product,
    job_id: m.jobId,
    module_type: m.moduleType,
    out_dir: m.outDir,
    total_files: m.download.files.length,
    total_bytes_est: m.download.totalBytes,
    truncated: m.download.truncated,
  };
  if (m.latestCompletedJobId !== undefined) {
    out.latest_completed_job_id = m.latestCompletedJobId;
  }
  if (m.driftLookupFailed) {
    out.drift_lookup_failed = true;
  }
  if (m.moduleType === "free-tier" && m.report) {
    out.report_sections = reportSections(m.report);
  }
  printJson(out);
}

function emitSummary(opts: ResultsCommandOptions, m: ResolvedManifest): void {
  if (m.moduleType === "free-tier" && m.report) {
    const r = m.report as Record<string, Record<string, unknown> | undefined>;
    const summary: Record<string, unknown> = {};
    for (const key of [
      "landscape",
      "advantages",
      "buyers",
      "blockers",
      "growthPlan",
    ]) {
      const tab = r[key];
      if (tab && typeof tab === "object") {
        const kf = (tab as { keyFinding?: unknown }).keyFinding;
        if (kf && typeof kf === "object") {
          summary[key] = kf;
        }
      }
    }
    const out: Record<string, unknown> = {
      product: opts.product,
      job_id: m.jobId,
      module_type: m.moduleType,
      summary,
    };
    if (m.latestCompletedJobId !== undefined) {
      out.latest_completed_job_id = m.latestCompletedJobId;
    }
    if (m.driftLookupFailed) {
      out.drift_lookup_failed = true;
    }
    printJson(out);
    return;
  }
  // workflow / unlock / idea-eval / smoke-test → stub
  const out: Record<string, unknown> = {
    product: opts.product,
    job_id: m.jobId,
    module_type: m.moduleType,
    summary: {
      stub: true,
      message:
        "Executive summary lands in Phase 2 (manifest endpoint). Use --show <path> on a downloaded file in the meantime.",
    },
  };
  if (m.latestCompletedJobId !== undefined) {
    out.latest_completed_job_id = m.latestCompletedJobId;
  }
  if (m.driftLookupFailed) {
    out.drift_lookup_failed = true;
  }
  printJson(out);
}

function emitShow(opts: ResultsCommandOptions, m: ResolvedManifest): void {
  const path = opts.show!;
  const raw = readLocalFile(m.outDir, path);
  let body = raw;
  let truncated = false;
  if (
    typeof opts.maxTokens === "number" &&
    Number.isFinite(opts.maxTokens) &&
    opts.maxTokens > 0
  ) {
    const charBudget = opts.maxTokens * TOKEN_CHARS_RATIO;
    if (body.length > charBudget) {
      const shownTokens = opts.maxTokens;
      const totalTokens = Math.ceil(body.length / TOKEN_CHARS_RATIO);
      body =
        body.slice(0, charBudget) +
        `\n\n[... truncated, ${shownTokens} tokens of ${totalTokens} shown ...]\n`;
      truncated = true;
    }
  }
  // `--show` is cat-style: raw to stdout so `> file` works as documented.
  // `--json` opts into the `{path, contents}` envelope, matching `skill show`.
  // Drift metadata threads through the same envelope (matching the manifest /
  // --summary / --stage / --tactic JSON paths) so `--show --json --quiet`
  // never strips the integrity signal — printProgress is silenced by --quiet
  // but the machine-readable envelope must carry the drift state regardless.
  if (getOutputConfig().json) {
    const envelope: Record<string, unknown> = { path, contents: body };
    if (truncated) envelope.truncated = true;
    if (m.latestCompletedJobId !== undefined) {
      envelope.latest_completed_job_id = m.latestCompletedJobId;
    }
    if (m.driftLookupFailed) {
      envelope.drift_lookup_failed = true;
    }
    printJson(envelope);
    return;
  }
  process.stdout.write(body);
  if (!body.endsWith("\n")) process.stdout.write("\n");
}

function rejectStageTacticForNonFreeTier(
  opts: ResultsCommandOptions,
  m: ResolvedManifest,
): void {
  if ((opts.stage || opts.tactic) && m.moduleType !== "free-tier") {
    throw new UsageError(
      "Manifest mode (Phase 2) required for --stage/--tactic on workflow/unlock. Run `diffmode results " +
        opts.product +
        " --pull` and inspect with --show <path>.",
    );
  }
}

function emitFreeTierStageOrTactic(
  opts: ResultsCommandOptions,
  m: ResolvedManifest,
): boolean {
  if (!opts.stage && !opts.tactic) return false;
  if (!m.report) {
    throw new UsageError(
      "Report not available for this job; cannot filter by --stage/--tactic.",
    );
  }
  const r = m.report as Record<string, unknown>;
  if (opts.stage) {
    const section = r[opts.stage];
    if (section === undefined) {
      throw new NotFoundError(
        `Stage '${opts.stage}' not found in report. Available: ${Object.keys(r).join(", ")}`,
      );
    }
    const out: Record<string, unknown> = {
      product: opts.product,
      job_id: m.jobId,
      stage: opts.stage,
      section: section as Record<string, unknown>,
    };
    if (m.latestCompletedJobId !== undefined) {
      out.latest_completed_job_id = m.latestCompletedJobId;
    }
    if (m.driftLookupFailed) {
      out.drift_lookup_failed = true;
    }
    printJson(out);
    return true;
  }
  // --tactic: dig into growthPlan.tactics if present
  const growthPlan = r["growthPlan"];
  if (growthPlan && typeof growthPlan === "object") {
    const tactics = (growthPlan as { tactics?: unknown }).tactics;
    if (Array.isArray(tactics)) {
      const slug = opts.tactic!.toLowerCase();
      const match = tactics.find((t: unknown) => {
        if (!t || typeof t !== "object") return false;
        const tt = t as Record<string, unknown>;
        const id = typeof tt["id"] === "string" ? (tt["id"] as string) : "";
        const name =
          typeof tt["name"] === "string" ? (tt["name"] as string) : "";
        return id.toLowerCase() === slug || name.toLowerCase() === slug;
      });
      if (!match) {
        throw new NotFoundError(
          `Tactic '${opts.tactic}' not found in growthPlan.tactics.`,
        );
      }
      const out: Record<string, unknown> = {
        product: opts.product,
        job_id: m.jobId,
        tactic: opts.tactic,
        details: match as Record<string, unknown>,
      };
      if (m.latestCompletedJobId !== undefined) {
        out.latest_completed_job_id = m.latestCompletedJobId;
      }
      if (m.driftLookupFailed) {
        out.drift_lookup_failed = true;
      }
      printJson(out);
      return true;
    }
  }
  throw new NotFoundError(
    `Tactic '${opts.tactic}' not found (no growthPlan.tactics in report).`,
  );
}

function driftMessage(pinned: string, latest: string, outDir: string): string {
  return `Note: --job-id ${pinned} pins the manifest metadata, but downloaded files reflect the current product workspace (latest completed job: ${latest}). Files written to ${outDir} to avoid overwriting any prior snapshot at ${pinned}. Per-job artifact snapshots ship in Phase 2.`;
}

function driftUnknownMessage(pinned: string, outDir: string): string {
  return `Warning: --job-id ${pinned} drift status could not be verified (advisory lookup failed). Downloaded files reflect the current product workspace and may or may not match the pinned job. Wrote to ${outDir} (quarantined under -unverified to protect any prior ${pinned} snapshot); review before relying on the contents.`;
}

// `--out <dir>` skips the auto-redirect/quarantine that the default and
// `--out-base` paths apply on drift — the user pinned the destination, so the
// CLI honors it verbatim. Surface the diverged shape honestly so an agent /
// human knows nothing was auto-protected and any prior pinned snapshot at
// `--out` may have been overwritten.
function driftMessageOutExplicit(
  pinned: string,
  latest: string,
  outDir: string,
): string {
  return `Note: --job-id ${pinned} pins the manifest metadata, but downloaded files reflect the current product workspace (latest completed job: ${latest}). Files written to ${outDir} (--out, no auto-redirect applied) — any prior snapshot at this path may have been overwritten. Per-job artifact snapshots ship in Phase 2.`;
}

function driftUnknownMessageOutExplicit(
  pinned: string,
  outDir: string,
): string {
  return `Warning: --job-id ${pinned} drift status could not be verified (advisory lookup failed). Downloaded files reflect the current product workspace and may or may not match the pinned job. Wrote to ${outDir} (--out, no auto-quarantine applied) — any prior snapshot at this path may have been overwritten; review before relying on the contents.`;
}

export async function resultsCommand(
  opts: ResultsCommandOptions,
): Promise<void> {
  try {
    const m = await resolveAndDownload(opts);

    // Drift signalling depends on whether the output mode emits a JSON
    // envelope. JSON modes (manifest/--summary/--stage/--tactic, plus
    // --show when --json is set) carry `latest_completed_job_id` /
    // `drift_lookup_failed` for machine consumers, so the stderr note is
    // a human aid that --quiet legitimately silences. Cat-style modes
    // (--pull, --show without --json) emit no JSON envelope, so stderr is
    // the only signal — drift bypasses --quiet there since it's an
    // integrity warning, not progress.
    const showRawCat = opts.show !== undefined && !getOutputConfig().json;
    const hasJsonEnvelope = !opts.pull && !showRawCat;
    const explicitOut = opts.out !== undefined;
    if (m.latestCompletedJobId !== undefined && opts.jobId !== undefined) {
      const note = explicitOut
        ? driftMessageOutExplicit(opts.jobId, m.latestCompletedJobId, m.outDir)
        : driftMessage(opts.jobId, m.latestCompletedJobId, m.outDir);
      if (hasJsonEnvelope) {
        printProgress(note);
      } else {
        process.stderr.write(note + "\n");
      }
    } else if (m.driftLookupFailed && opts.jobId !== undefined) {
      // Advisory lookup failed — we don't know whether drift exists. Surface
      // the uncertainty so agents/humans don't silently trust the snapshot.
      const note = explicitOut
        ? driftUnknownMessageOutExplicit(opts.jobId, m.outDir)
        : driftUnknownMessage(opts.jobId, m.outDir);
      if (hasJsonEnvelope) {
        printProgress(note);
      } else {
        process.stderr.write(note + "\n");
      }
    }

    if (opts.pull) {
      // Silent download — no manifest, no summary, no body on stdout.
      printProgress(
        `Downloaded ${m.download.files.length} file(s) to ${m.outDir}`,
      );
      return;
    }

    rejectStageTacticForNonFreeTier(opts, m);

    if (opts.show) {
      emitShow(opts, m);
      return;
    }
    if (opts.stage || opts.tactic) {
      if (emitFreeTierStageOrTactic(opts, m)) return;
    }
    if (opts.summary) {
      emitSummary(opts, m);
      return;
    }
    emitManifest(opts, m);
  } catch (err) {
    printError(err);
  }
}
