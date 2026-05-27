// Cost resolution is server-authoritative — see `/billing/balance.credit_costs`.
import type { HttpClient } from "./http";
import { InsufficientCreditsError, PricingUnavailableError } from "./errors";

export interface CreditBalancePayload {
  user_id: string;
  balance: number;
  has_stripe_customer: boolean;
  has_purchased: boolean;
  credit_costs: {
    workflow: number;
    unlock: number;
    "idea-eval": number;
    "smoke-test": number;
    run: number;
  };
}

export type PreflightAction =
  | "workflow"
  | "unlock"
  | "idea-eval"
  | "smoke-test"
  | "run";

export interface PreflightCreditsArgs {
  client: HttpClient;
  action: PreflightAction;
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
  const costs = payload.credit_costs;
  if (!costs) {
    throw new PricingUnavailableError(
      "Pricing data missing from server response. Update diffmode CLI or check backend version.",
    );
  }
  const required = costs[args.action];
  if (required === undefined) {
    throw new PricingUnavailableError(
      `Pricing data missing for action '${args.action}'. Update diffmode CLI or check backend version.`,
    );
  }
  if (payload.balance < required) {
    throw new InsufficientCreditsError(
      `Insufficient credits (need ${required}, have ${payload.balance}). Top up at ${args.billingUrl}`,
      args.billingUrl,
    );
  }
  return {
    balance: payload.balance,
    required,
    has_purchased: payload.has_purchased,
  };
}
