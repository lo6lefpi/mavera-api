import { addMonths, type IsoDate, startOfMonth } from "./dates.ts";
import { PricingError } from "./errors.ts";
import {
  type BillingOption,
  COMMITMENT_MONTHS,
  EXTRA_ACCOUNT_MONTHLY_CENTS,
  EXTRA_FILING_CENTS,
  EXTRA_TRANSACTION_CENTS,
  type FilingFrequency,
  GRID_VERSION,
  isBillingOption,
  isStandardPlan,
  type PlanCode,
  type PlanPricing,
  PLANS,
  type StandardPlanCode,
} from "./grid.ts";
import type { Cents } from "./money.ts";

export type BillingCycle = "month" | "year";

/**
 * Conditions accordées à un client au moment où il accepte un forfait :
 * tout ce qui change ce qu'on lui facture ou ce à quoi il a droit. La base
 * les enregistre (subscription_plan_periods et subscriptions) : une nouvelle
 * grille ne les change pas, et les suppléments se calculent à partir d'elles,
 * jamais à partir de PLANS.
 *
 * Les services décrits en mots (rapports, soutien, suivi des factures) font
 * partie du contrat de services : gridVersion indique quelle version
 * s'applique, et chaque version du contrat doit être conservée.
 */
export interface GrantedTerms {
  readonly gridVersion: string;
  readonly planCode: StandardPlanCode;
  readonly billingOption: BillingOption;
  readonly cycle: BillingCycle;
  /** Prix par cycle : un mois, ou une année pour l'annuel. */
  readonly recurringPriceCents: Cents;
  readonly includedTransactions: number;
  readonly extraTransactionCents: Cents;
  /** Comptes bancaires ou cartes inclus. */
  readonly includedAccounts: number;
  readonly extraAccountCents: Cents;
  /** Fréquence de TPS/TVQ la plus élevée incluse. */
  readonly includedFilingFrequency: FilingFrequency;
  readonly extraFilingCents: Cents;
  /** QuickBooks Ledger fourni par la firme. */
  readonly quickbooksIncluded: boolean;
  /** Frais d'ouverture selon l'option choisie (payés une fois). */
  readonly openingFeeCents: Cents;
  /** Rabais obtenu sur l'ouverture grâce à l'engagement (0 sans engagement). */
  readonly openingDiscountCents: Cents;
  /**
   * Clé de recherche du prix récurrent Stripe (lookup_key). integrations/stripe
   * la convertit en identifiant de prix, qui diffère entre test et production.
   * Les frais d'ouverture n'ont pas de prix Stripe : ils sont facturés au
   * montant accordé, dans la session de paiement.
   */
  readonly stripeRecurringLookupKey: string;
}

export function getPlan(code: PlanCode | string): PlanPricing {
  if (code === "sur_mesure") {
    throw new PricingError(
      "plan_not_purchasable",
      "Sur mesure passe par une soumission, sans paiement direct",
    );
  }
  if (!isStandardPlan(code)) {
    throw new PricingError("invalid_input", `Forfait inconnu : ${code}`);
  }
  return PLANS[code];
}

export function assertBillingOffered(plan: PlanPricing, billing: BillingOption | string): void {
  if (!isBillingOption(billing)) {
    throw new PricingError("invalid_input", `Option de facturation inconnue : ${billing}`);
  }
  if (!plan.billingOptions.includes(billing)) {
    throw new PricingError(
      "billing_not_offered",
      `${plan.name} n'est pas offert avec l'option « ${billing} »`,
    );
  }
}

export function cycleOf(billing: BillingOption): BillingCycle {
  return billing === "annual" ? "year" : "month";
}

export function cycleMonths(billing: BillingOption): number {
  return billing === "annual" ? 12 : 1;
}

export function hasCommitment(billing: BillingOption): boolean {
  return billing !== "monthly";
}

/** Prix par cycle (mois ou année) selon l'option. */
export function recurringPrice(plan: PlanPricing, billing: BillingOption): Cents {
  assertBillingOffered(plan, billing);
  if (billing === "annual") {
    // assertBillingOffered garantit qu'un prix annuel existe.
    return plan.annualCents as Cents;
  }
  return plan.monthlyCents;
}

/** Frais d'ouverture : prix complet sans engagement, moitié prix avec engagement ou annuel. */
export function openingFee(plan: PlanPricing, billing: BillingOption): Cents {
  assertBillingOffered(plan, billing);
  if (hasCommitment(billing) && plan.openingFee.reducedCents !== null) {
    return plan.openingFee.reducedCents;
  }
  return plan.openingFee.fullCents;
}

function lookupKeySuffix(): string {
  return GRID_VERSION.replace(/-/g, "_");
}

export function grantTerms(planCode: PlanCode | string, billing: BillingOption | string): GrantedTerms {
  const plan = getPlan(planCode);
  assertBillingOffered(plan, billing);
  const option = billing as BillingOption;
  const cycle = cycleOf(option);
  return {
    gridVersion: GRID_VERSION,
    planCode: plan.code,
    billingOption: option,
    cycle,
    recurringPriceCents: recurringPrice(plan, option),
    includedTransactions: plan.includedTransactions,
    extraTransactionCents: EXTRA_TRANSACTION_CENTS,
    includedAccounts: plan.includedAccounts,
    extraAccountCents: EXTRA_ACCOUNT_MONTHLY_CENTS,
    includedFilingFrequency: plan.includedFilingFrequency,
    extraFilingCents: EXTRA_FILING_CENTS,
    quickbooksIncluded: plan.quickbooksIncluded,
    openingFeeCents: openingFee(plan, option),
    openingDiscountCents: plan.openingFee.fullCents - openingFee(plan, option),
    stripeRecurringLookupKey: `${plan.code}_${cycle === "year" ? "annual" : "monthly"}_${lookupKeySuffix()}`,
  };
}

/**
 * Fin de l'engagement : 12 mois après le début du premier mois couvert.
 * null pour le mensuel sans engagement. Ce qui est dû si le dossier est fermé
 * avant : voir earlyTerminationFee (termination.ts).
 */
export function commitmentEndsOn(startsOn: IsoDate, billing: BillingOption): IsoDate | null {
  if (!hasCommitment(billing)) return null;
  return addMonths(startOfMonth(startsOn), COMMITMENT_MONTHS);
}
