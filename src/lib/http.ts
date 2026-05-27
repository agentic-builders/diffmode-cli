import {
  AuthError,
  ConflictError,
  InsufficientCreditsError,
  NetworkError,
  NotFoundError,
  PricingUnavailableError,
  RateLimitedError,
  ServerError,
  UsageError,
} from "./errors";

// Backend's PricingConfigError (api/credit_cost_store.py) returns
// HTTP 503 with this exact detail string. The CLI must surface it as
// PricingUnavailableError (exit 11), not as a generic ServerError
// (exit 9), so users see the fail-closed pricing condition the README
// promises ("If the server's pricing table is unreachable, the CLI
// exits with code 11").
const PRICING_UNAVAILABLE_DETAIL = "Pricing configuration unavailable";

export const DEFAULT_API_BASE = "https://ai-cmo-api.onrender.com/public/v1";
export const DEFAULT_BILLING_URL = "https://diffmode.app/app/billing";
export const DEFAULT_TIMEOUT_MS = 60_000;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  baseUrl?: string;
  token?: string | null;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  billingUrl?: string;
  verbose?: boolean;
  verboseLog?: (line: string) => void;
  userAgent?: string;
}

export interface RequestOptions {
  idempotencyKey?: string;
}

export interface HttpResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

interface ServerErrorEnvelope {
  // FastAPI returns `detail` as a string for HTTPException, or as a structured
  // array `[{loc, msg, type, input}]` for Pydantic validation (422). We accept
  // anything here and normalize via `formatDetail()`.
  detail?: unknown;
  job_id?: string;
  checkout_url?: string;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    retry_after?: number;
    job_id?: string;
    product_id?: string;
  };
}

function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map(formatDetailItem).filter((s) => s.length > 0);
    return parts.join("; ");
  }
  if (typeof detail === "object") {
    return formatDetailItem(detail) || JSON.stringify(detail);
  }
  return String(detail);
}

function formatDetailItem(item: unknown): string {
  if (item === null || typeof item !== "object") return String(item);
  const rec = item as Record<string, unknown>;
  const msg = typeof rec["msg"] === "string" ? (rec["msg"] as string) : "";
  const loc = Array.isArray(rec["loc"]) ? (rec["loc"] as unknown[]) : null;
  if (msg && loc && loc.length > 0) {
    // Drop the leading `body`/`query`/`path` segment; agents care about the
    // field path, not the request location.
    const path = loc
      .filter((s, i) => !(i === 0 && (s === "body" || s === "query" || s === "path")))
      .map((s) => String(s))
      .join(".");
    return path ? `${path}: ${msg}` : msg;
  }
  if (msg) return msg;
  return JSON.stringify(item);
}

function joinUrl(base: string, path: string): string {
  if (!path) return base;
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${cleanPath}`;
}

function bodyExcerpt(text: string, limit = 200): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "…";
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly billingUrl: string;
  private readonly verbose: boolean;
  private readonly verboseLog: (line: string) => void;
  private readonly userAgent: string;

  constructor(opts: HttpClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_API_BASE;
    this.token = opts.token ?? null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i));
    this.billingUrl = opts.billingUrl ?? DEFAULT_BILLING_URL;
    this.verbose = Boolean(opts.verbose);
    this.verboseLog =
      opts.verboseLog ?? ((s) => process.stderr.write(s + "\n"));
    this.userAgent = opts.userAgent ?? "diffmode-cli";
  }

  get<T = unknown>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>("GET", path);
  }

  post<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
    reqOpts?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    return this.request<T>("POST", path, body, reqOpts);
  }

  delete<T = unknown>(path: string): Promise<HttpResponse<T>> {
    return this.request<T>("DELETE", path);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    reqOpts?: RequestOptions,
  ): Promise<HttpResponse<T>> {
    const url = joinUrl(this.baseUrl, path);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    // Per-request idempotency key — only the caller's terminal submit POST
    // attaches the header. Preflight GETs and incidental POSTs (e.g.
    // /analyze-website) intentionally do not inherit the key.
    if (reqOpts?.idempotencyKey) {
      headers["Idempotency-Key"] = reqOpts.idempotencyKey;
    }

    if (this.verbose) {
      const redacted: Record<string, string> = { ...headers };
      if (redacted["Authorization"]) redacted["Authorization"] = "Bearer ***";
      this.verboseLog(`→ ${method} ${url} headers=${JSON.stringify(redacted)}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Keep the abort controller alive across BOTH the headers-received
    // (`fetch`) and body-consumed (`response.text()`) phases — a server
    // that streams headers quickly but dribbles the body would otherwise
    // hang the CLI indefinitely after the previous early `clearTimeout`.
    try {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const e = err as Error & { name?: string };
        if (e?.name === "AbortError") {
          throw new NetworkError(
            `Request timed out after ${this.timeoutMs}ms: ${method} ${url}`,
          );
        }
        throw new NetworkError(
          `Network error: ${e?.message ?? String(err)} (${method} ${url})`,
        );
      }

      if (this.verbose) {
        this.verboseLog(`← ${response.status} ${method} ${url}`);
      }

      if (response.status === 204) {
        return {
          status: response.status,
          data: null as unknown as T,
          headers: response.headers,
        };
      }

      let rawText: string;
      try {
        rawText = await response.text();
      } catch (err) {
        const e = err as Error & { name?: string };
        if (e?.name === "AbortError") {
          throw new NetworkError(
            `Response body timed out after ${this.timeoutMs}ms: ${method} ${url}`,
          );
        }
        throw new NetworkError(
          `Network error reading response body: ${e?.message ?? String(err)} (${method} ${url})`,
        );
      }

      if (response.ok) {
        if (rawText.length === 0) {
          return {
            status: response.status,
            data: null as unknown as T,
            headers: response.headers,
          };
        }
        try {
          return {
            status: response.status,
            data: JSON.parse(rawText) as T,
            headers: response.headers,
          };
        } catch {
          throw new NetworkError(
            `Failed to parse JSON response (${response.status}): ${bodyExcerpt(rawText)}`,
          );
        }
      }

      // Error status — map to typed error
      let envelope: ServerErrorEnvelope = {};
      try {
        envelope = JSON.parse(rawText) as ServerErrorEnvelope;
      } catch {
        // Non-JSON error bodies (gateway HTML, debug stacks) get truncated to
        // avoid dumping multi-KB pages into stderr/agent logs.
        envelope = { detail: bodyExcerpt(rawText) };
      }
      throw this.mapError(response, envelope);
    } finally {
      clearTimeout(timer);
    }
  }

  private mapError(response: Response, envelope: ServerErrorEnvelope): Error {
    const status = response.status;
    const detail =
      formatDetail(envelope.detail) || envelope.error?.message || `HTTP ${status}`;
    if (status === 401) {
      return new AuthError(
        `${detail} — run \`diffmode login\` to authenticate.`,
      );
    }
    if (status === 402) {
      return new InsufficientCreditsError(detail, this.billingUrl);
    }
    if (status === 404) {
      return new NotFoundError(detail);
    }
    if (status === 409) {
      const jobId = envelope.error?.job_id ?? envelope.job_id ?? "";
      const productId = envelope.error?.product_id;
      return new ConflictError(detail, jobId, productId);
    }
    if (status === 422) {
      return new UsageError(detail);
    }
    if (status === 429) {
      const headerVal = response.headers.get("Retry-After");
      let retryAfter: number | undefined;
      if (headerVal !== null && headerVal !== "") {
        const n = Number.parseInt(headerVal, 10);
        if (Number.isFinite(n) && n > 0) retryAfter = n;
      }
      if (retryAfter === undefined && envelope.error?.retry_after) {
        retryAfter = envelope.error.retry_after;
      }
      return new RateLimitedError(detail, retryAfter);
    }
    if (status === 503 && detail.includes(PRICING_UNAVAILABLE_DETAIL)) {
      return new PricingUnavailableError(detail);
    }
    if (status >= 500) {
      const retryable = envelope.error?.retryable ?? true;
      return new ServerError(detail, retryable);
    }
    // Fallback: any other 4xx → usage error so the caller exits cleanly.
    return new UsageError(`HTTP ${status}: ${detail}`);
  }
}
