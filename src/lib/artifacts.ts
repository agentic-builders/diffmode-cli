import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { HttpClient } from "./http";
import { NotFoundError, UsageError, isDiffmodeError } from "./errors";

export interface CompletedJobInfo {
  job_id: string;
  module_type: string;
  product_id: string;
  created_at?: string;
}

export interface OutputFile {
  path: string;
  content: string;
}

interface JobSummary {
  job_id: string;
  status: string;
  product_id?: string | null;
  module_type?: string | null;
  created_at?: string | null;
}

interface JobListResponseShape {
  jobs: JobSummary[];
  total: number;
  next_cursor: string | null;
}

interface ProductOutputsShape {
  product_id: string;
  files: OutputFile[];
  total_files: number;
  truncated?: boolean;
}

export interface ResolveLatestArgs {
  client: HttpClient;
  product: string;
  jobId?: string;
}

export async function resolveLatestCompletedJob(
  args: ResolveLatestArgs,
): Promise<CompletedJobInfo | null> {
  const { client, product, jobId } = args;
  if (jobId) {
    const resp = await client.get<JobSummary>(
      `/jobs/${encodeURIComponent(jobId)}`,
    );
    const job = resp.data;
    if (job.product_id && job.product_id !== product) {
      throw new UsageError(
        `Job ${jobId} belongs to product '${job.product_id}', not '${product}'.`,
      );
    }
    if (job.status !== "completed") {
      throw new UsageError(
        `Job ${jobId} is in status '${job.status}' — results require status 'completed'. Use \`diffmode jobs watch ${jobId}\` to wait, then re-run.`,
      );
    }
    return {
      job_id: job.job_id,
      module_type: job.module_type ?? "",
      product_id: job.product_id ?? product,
      ...(job.created_at ? { created_at: job.created_at } : {}),
    };
  }

  const qs = new URLSearchParams();
  qs.set("product_id", product);
  qs.set("status", "completed");
  qs.set("limit", "200");
  const resp = await client.get<JobListResponseShape>(`/jobs?${qs.toString()}`);
  const completed = resp.data.jobs.filter((j) => j.status === "completed");
  if (completed.length === 0) return null;

  // Pick the most recent by created_at; if missing, preserve listing order.
  const sorted = [...completed].sort((a, b) => {
    const aT = a.created_at ? Date.parse(a.created_at) : 0;
    const bT = b.created_at ? Date.parse(b.created_at) : 0;
    return bT - aT;
  });
  const newest = sorted[0]!;
  return {
    job_id: newest.job_id,
    module_type: newest.module_type ?? "",
    product_id: newest.product_id ?? product,
    ...(newest.created_at ? { created_at: newest.created_at } : {}),
  };
}

export interface DownloadOutputsArgs {
  client: HttpClient;
  product: string;
  outDir: string;
}

export interface DownloadedFile {
  path: string;
  bytes: number;
  skipped: boolean;
}

export interface DownloadResult {
  outDir: string;
  files: DownloadedFile[];
  totalBytes: number;
  truncated: boolean;
}

function ensureWithinBase(base: string, candidate: string): string {
  const absBase = resolve(base);
  const absCandidate = resolve(base, candidate);
  const rel = relative(absBase, absCandidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UsageError(
      `Refusing to write outside outDir: '${candidate}' escapes base.`,
    );
  }
  return absCandidate;
}

export async function downloadProductOutputs(
  args: DownloadOutputsArgs,
): Promise<DownloadResult> {
  const { client, product, outDir } = args;
  const resp = await client.get<ProductOutputsShape>(
    `/products/${encodeURIComponent(product)}/outputs`,
  );
  const payload = resp.data;

  mkdirSync(outDir, { recursive: true });

  const downloaded: DownloadedFile[] = [];
  let totalBytes = 0;

  for (const file of payload.files) {
    const target = ensureWithinBase(outDir, file.path);
    const bytes = Buffer.byteLength(file.content, "utf-8");

    let skipped = false;
    if (existsSync(target)) {
      const existing = readFileSync(target, "utf-8");
      if (existing === file.content) {
        skipped = true;
      }
    }

    if (!skipped) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { encoding: "utf-8", mode: 0o644 });
      // Some platforms ignore mode in writeFileSync if file exists; enforce.
      chmodSync(target, 0o644);
    }

    downloaded.push({ path: file.path, bytes, skipped });
    totalBytes += bytes;
  }

  return {
    outDir,
    files: downloaded,
    totalBytes,
    truncated: Boolean(payload.truncated),
  };
}

export interface DownloadReportArgs {
  client: HttpClient;
  product: string;
}

export async function downloadProductReport(
  args: DownloadReportArgs,
): Promise<Record<string, unknown> | null> {
  const { client, product } = args;
  try {
    const resp = await client.get<Record<string, unknown>>(
      `/products/${encodeURIComponent(product)}/report`,
    );
    return resp.data;
  } catch (err) {
    if (isDiffmodeError(err) && err instanceof NotFoundError) {
      return null;
    }
    throw err;
  }
}

export function defaultOutDir(product: string, jobId: string): string {
  return join(".diffmode", product, jobId);
}

export function readLocalFile(outDir: string, relPath: string): string {
  const target = ensureWithinBase(outDir, relPath);
  if (!existsSync(target)) {
    throw new UsageError(`File not found in outputs: ${relPath}`);
  }
  return readFileSync(target, "utf-8");
}
