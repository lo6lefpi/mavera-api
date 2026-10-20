import { PLANS } from "./grid.ts";
import { assertCount } from "./money.ts";

export interface TrajetProfile {
  /** Tous les revenus viennent de plateformes de covoiturage ou de livraison. */
  readonly platformIncomeOnly: boolean;
  readonly accounts: number;
  readonly issuesClientInvoices: boolean;
  /** Transactions habituelles par mois. */
  readonly monthlyTransactions: number;
}

export type TrajetReason = "other_income" | "too_many_accounts" | "client_invoices" | "too_many_transactions";

/**
 * Admissibilité à Trajet : revenus de plateformes seulement, un seul compte,
 * aucune facture client, au plus 15 transactions par mois de façon régulière.
 * Sinon, Départ prend le relais. Les réponses sont déclarées par le client;
 * la teneuse de livres les vérifie à l'appel de bienvenue.
 */
export function trajetEligibility(profile: TrajetProfile): { eligible: boolean; reasons: TrajetReason[] } {
  assertCount(profile.accounts, "accounts");
  assertCount(profile.monthlyTransactions, "monthlyTransactions");
  const reasons: TrajetReason[] = [];
  if (!profile.platformIncomeOnly) reasons.push("other_income");
  if (profile.accounts > PLANS.trajet.includedAccounts) reasons.push("too_many_accounts");
  if (profile.issuesClientInvoices) reasons.push("client_invoices");
  if (profile.monthlyTransactions > PLANS.trajet.includedTransactions) reasons.push("too_many_transactions");
  return { eligible: reasons.length === 0, reasons };
}
