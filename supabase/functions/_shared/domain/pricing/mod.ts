/**
 * domain/pricing — seule source des prix de l'entreprise.
 *
 * Aucune dépendance (ni Supabase, ni Stripe, ni réseau) : tout se teste
 * hors ligne. Les montants sont des cents entiers, avant taxes.
 *
 * Qui l'utilise :
 * - public-api : aperçu du prix (quoteCheckout, qui vérifie aussi
 *   l'admissibilité à Trajet, et suggestPlan) et session Stripe;
 * - stripe-webhook : conditions accordées enregistrées au paiement (grantTerms);
 * - admin-api : changements de forfait, mise à jour de vos livres, options,
 *   frais de départ anticipé;
 * - scheduled-jobs (P1) : transactions supplémentaires du mois (countMonth).
 */
export { PricingError, type PricingErrorCode } from "./errors.ts";
export { type Cents, formatCad } from "./money.ts";
export { type IsoDate } from "./dates.ts";
export {
  ANNUAL_MONTHS_CHARGED,
  type BillingOption,
  BOOKS_UPDATE,
  COACHING,
  COMMITMENT_MONTHS,
  EXTRA_ACCOUNT_MONTHLY_CENTS,
  EXTRA_FILING_CENTS,
  EXTRA_TRANSACTION_CENTS,
  type FilingFrequency,
  GRID_VERSION,
  isBillingOption,
  isFilingFrequency,
  isStandardPlan,
  type PlanCode,
  type PlanPricing,
  PLANS,
  STANDALONE_FILING_CENTS,
  type StandardPlanCode,
} from "./grid.ts";
export {
  type BillingCycle,
  commitmentEndsOn,
  type GrantedTerms,
  getPlan,
  grantTerms,
  hasCommitment,
  openingFee,
  recurringPrice,
} from "./terms.ts";
export { type CheckoutQuote, type CheckoutRequest, quoteCheckout, type StartMonth } from "./checkout.ts";
export { countMonth, type MonthlyCount, type PlanPeriod, type QuotaTerms, termsForMonth } from "./overage.ts";
export {
  type CurrentSubscription,
  type DowngradeQuote,
  planChangeDirection,
  quoteDowngrade,
  quoteUpgrade,
  quoteWelcomeCallDowngrade,
  type UpgradeQuote,
  type WelcomeCallDowngradeQuote,
} from "./plan-change.ts";
export { type BooksUpdateQuote, type BooksUpdateRequest, quoteBooksUpdate, splitInstallments } from "./books-update.ts";
export {
  addOnUnitPrice,
  coachingCharge,
  extraAccounts,
  filingSupplement,
  standaloneFilingPrice,
  type SupplementTerms,
} from "./services.ts";
export { type CloseReason, type CommitmentTerms, earlyTerminationFee, type TerminationFee } from "./termination.ts";
export { type PlanEstimate, type SimulatorProfile, suggestPlan, type Suggestion } from "./simulator.ts";
export { trajetEligibility, type TrajetProfile, type TrajetReason } from "./eligibility.ts";
