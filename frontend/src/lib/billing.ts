import { api } from "./api";

export interface Entitlement {
  entitled: boolean;
  canExtend: boolean;
  status: string; // trialing | active | past_due | canceled
  trialEndsAt: number;
  periodEnd: number;
  extensionsLeft: number;
  daysLeft: number;
}

export async function billingStatus(): Promise<Entitlement> {
  const { entitlement } = await api<{ entitlement: Entitlement }>("/api/billing/status");
  return entitlement;
}

export async function checkout(plan: "monthly" | "yearly"): Promise<string> {
  const { url } = await api<{ url: string }>("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
  return url;
}

export async function extendTrial(): Promise<Entitlement> {
  const { entitlement } = await api<{ entitlement: Entitlement }>(
    "/api/billing/trial/extend",
    { method: "POST", body: "{}" }
  );
  return entitlement;
}
