import type { HttpClient } from "./http";
import { InsufficientCreditsError } from "./errors";

export interface CreditBalancePayload {
  balance: number;
  has_stripe_customer: boolean;
  has_purchased: boolean;
}

export const MODULE_CREDIT_COSTS: Readonly<Record<string, number>> = Object.freeze(
  {
    run: 1,
    "smoke-test": 1,
    "idea-eval": 5,
    unlock: 15,
    workflow: 15,
  },
);

export interface PreflightCreditsArgs {
  client: HttpClient;
  required: number;
  billingUrl: string;
}

export interface PreflightCreditsResult {
  balance: number;
  required: number;
  has_purchased: boolean;
}

export async function fetchBalance(client: HttpClient): Promise<CreditBalancePayload> {
  const resp = await client.get<CreditBalancePayload>("/billing/balance");
  return resp.data;
}

export async function preflightCredits(
  args: PreflightCreditsArgs,
): Promise<PreflightCreditsResult> {
  const payload = await fetchBalance(args.client);
  if (payload.balance < args.required) {
    throw new InsufficientCreditsError(
      `Insufficient credits (need ${args.required}, have ${payload.balance}). Top up at ${args.billingUrl}`,
      args.billingUrl,
    );
  }
  return {
    balance: payload.balance,
    required: args.required,
    has_purchased: payload.has_purchased,
  };
}
