import { PLANS } from "./grid.ts";
import { assertCount } from "./money.ts";

export interface TrajetProfile {
  /** Tous les revenus viennent de plateformes de covoiturage ou de livraison. */
  readonly platformIncomeOnly: boolean;
  readonly accounts: number;
  readonly issuesClientInvoices: boolean;
}

export type TrajetReason = "other_income" | "too_many_accounts" | "client_invoices";

/**
 * Admissibilité à Trajet : revenus de plateformes seulement, au plus deux comptes,
 * aucune facture à ses propres clients. Les transactions au-delà du quota
 * restent admissibles et sont facturées au prix supplémentaire accordé.
 * Sinon, Départ prend le relais. Les réponses sont déclarées par le client;
 * la teneuse de livres les vérifie à l'appel de bienvenue.
 */
export function trajetEligibility(profile: TrajetProfile): { eligible: boolean; reasons: TrajetReason[] } {
  assertCount(profile.accounts, "accounts");
  const reasons: TrajetReason[] = [];
  if (!profile.platformIncomeOnly) reasons.push("other_income");
  if (profile.accounts > PLANS.trajet.includedAccounts) reasons.push("too_many_accounts");
  if (profile.issuesClientInvoices) reasons.push("client_invoices");
  return { eligible: reasons.length === 0, reasons };
}
