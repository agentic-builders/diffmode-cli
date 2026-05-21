import { ExitCode, type ExitCodeValue } from "./exit-codes";

export type DiffmodeErrorCode =
  | "generic"
  | "usage"
  | "network"
  | "auth"
  | "conflict"
  | "not_found"
  | "rate_limited"
  | "insufficient_credits"
  | "server"
  | "interrupted";

export interface DiffmodeErrorInit {
  code: DiffmodeErrorCode;
  message: string;
  retryable: boolean;
  exitCode: ExitCodeValue;
  retry_after?: number;
  docs_url?: string;
  job_id?: string;
  product_id?: string;
  billing_url?: string;
}

export interface DiffmodeErrorJSON {
  code: DiffmodeErrorCode;
  message: string;
  retryable: boolean;
  retry_after?: number;
  docs_url?: string;
  job_id?: string;
  product_id?: string;
  billing_url?: string;
}

export class DiffmodeError extends Error {
  readonly code: DiffmodeErrorCode;
  readonly retryable: boolean;
  readonly exitCode: ExitCodeValue;
  readonly retry_after: number | undefined;
  readonly docs_url: string | undefined;
  readonly job_id: string | undefined;
  readonly product_id: string | undefined;
  readonly billing_url: string | undefined;

  constructor(init: DiffmodeErrorInit) {
    super(init.message);
    this.name = "DiffmodeError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.exitCode = init.exitCode;
    this.retry_after = init.retry_after;
    this.docs_url = init.docs_url;
    this.job_id = init.job_id;
    this.product_id = init.product_id;
    this.billing_url = init.billing_url;
  }

  toJSON(): DiffmodeErrorJSON {
    const out: DiffmodeErrorJSON = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.retry_after !== undefined) out.retry_after = this.retry_after;
    if (this.docs_url !== undefined) out.docs_url = this.docs_url;
    if (this.job_id !== undefined) out.job_id = this.job_id;
    if (this.product_id !== undefined) out.product_id = this.product_id;
    if (this.billing_url !== undefined) out.billing_url = this.billing_url;
    return out;
  }
}

export class UsageError extends DiffmodeError {
  constructor(message: string, opts: { docs_url?: string } = {}) {
    super({
      code: "usage",
      message,
      retryable: false,
      exitCode: ExitCode.USAGE,
      docs_url: opts.docs_url,
    });
    this.name = "UsageError";
  }
}

export class NetworkError extends DiffmodeError {
  constructor(message: string) {
    super({
      code: "network",
      message,
      retryable: true,
      exitCode: ExitCode.NETWORK,
    });
    this.name = "NetworkError";
  }
}

export class AuthError extends DiffmodeError {
  constructor(message: string) {
    super({
      code: "auth",
      message,
      retryable: false,
      exitCode: ExitCode.AUTH,
    });
    this.name = "AuthError";
  }
}

export class ConflictError extends DiffmodeError {
  constructor(message: string, jobId: string, productId?: string) {
    super({
      code: "conflict",
      message,
      retryable: false,
      exitCode: ExitCode.CONFLICT,
      job_id: jobId,
      product_id: productId,
    });
    this.name = "ConflictError";
  }
}

export class NotFoundError extends DiffmodeError {
  constructor(message: string) {
    super({
      code: "not_found",
      message,
      retryable: false,
      exitCode: ExitCode.NOT_FOUND,
    });
    this.name = "NotFoundError";
  }
}

export class RateLimitedError extends DiffmodeError {
  constructor(message: string, retryAfter?: number) {
    super({
      code: "rate_limited",
      message,
      retryable: true,
      exitCode: ExitCode.RATE_LIMITED,
      retry_after: retryAfter,
    });
    this.name = "RateLimitedError";
  }
}

export class InsufficientCreditsError extends DiffmodeError {
  constructor(message: string, billingUrl: string) {
    super({
      code: "insufficient_credits",
      message,
      retryable: false,
      exitCode: ExitCode.INSUFFICIENT_CREDITS,
      billing_url: billingUrl,
    });
    this.name = "InsufficientCreditsError";
  }
}

export class ServerError extends DiffmodeError {
  constructor(message: string, retryable: boolean = true) {
    super({
      code: "server",
      message,
      retryable,
      exitCode: ExitCode.SERVER,
    });
    this.name = "ServerError";
  }
}

export class InterruptedResumableError extends DiffmodeError {
  constructor(message: string, jobId: string) {
    super({
      code: "interrupted",
      message,
      retryable: true,
      exitCode: ExitCode.INTERRUPTED_RESUMABLE,
      job_id: jobId,
    });
    this.name = "InterruptedResumableError";
  }
}

export function isDiffmodeError(err: unknown): err is DiffmodeError {
  return err instanceof DiffmodeError;
}
