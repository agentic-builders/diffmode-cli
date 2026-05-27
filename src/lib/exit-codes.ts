export const ExitCode = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NETWORK: 3,
  AUTH: 4,
  CONFLICT: 5,
  NOT_FOUND: 6,
  RATE_LIMITED: 7,
  INSUFFICIENT_CREDITS: 8,
  SERVER: 9,
  INTERRUPTED_RESUMABLE: 10,
  PRICING_UNAVAILABLE: 11,
  SIGINT: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];
