/**
 * Erreurs du domaine des prix. Les fonctions serveur les traduisent en
 * réponses HTTP (400 pour une entrée invalide, 409 pour une règle commerciale).
 */
export type PricingErrorCode =
  | "invalid_input" // valeur mal formée (montant, quantité, date)
  | "plan_not_purchasable" // Sur mesure : passe par une soumission
  | "billing_not_offered" // ex. Trajet en annuel ou avec engagement
  | "not_an_upgrade" // changement demandé dans le mauvais sens
  | "not_a_downgrade"
  | "same_plan"
  | "not_eligible" // critères de Trajet non respectés
  | "work_started" // remboursement de l'appel de bienvenue : le travail a commencé
  | "not_priced"; // service sans prix fixe (soumission ou proposition)

export class PricingError extends Error {
  readonly code: PricingErrorCode;
  /** Précisions lisibles par le code, ex. les critères de Trajet non remplis. */
  readonly details: readonly string[];

  constructor(code: PricingErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "PricingError";
    this.code = code;
    this.details = details;
  }
}

export function invalid(message: string): PricingError {
  return new PricingError("invalid_input", message);
}
