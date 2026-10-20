import { PricingError } from "./errors.ts";
import {
  ANNUAL_MONTHS_CHARGED,
  type FilingFrequency,
  PLANS,
  SIMULATOR_MAX_TRANSACTIONS,
  type StandardPlanCode,
} from "./grid.ts";
import { assertCount, type Cents, prorate } from "./money.ts";
import { extraAccounts, filingSupplement } from "./services.ts";
import { grantTerms } from "./terms.ts";

export type SimulatorBilling = "monthly" | "annual";

export interface SimulatorProfile {
  /** Comptes bancaires ou cartes; par défaut, ceux inclus dans chaque forfait. */
  readonly accounts?: number;
  /** Fréquence de TPS/TVQ fixée par Revenu Québec; par défaut, aucune déclaration en plus. */
  readonly filingFrequency?: FilingFrequency;
}

export interface PlanEstimate {
  readonly planCode: StandardPlanCode;
  readonly includedTransactions: number;
  readonly extraTransactions: number;
  /** Détail du coût mensuel récurrent estimé, avant taxes. */
  readonly planCents: Cents;
  readonly extraTransactionsCents: Cents;
  readonly extraAccountsCents: Cents;
  /** Déclarations en plus, ramenées au mois (total annuel ÷ 12). */
  readonly extraFilingsCents: Cents;
  readonly monthlyEstimateCents: Cents;
  /** Frais ponctuel, affiché à part du coût mensuel. */
  readonly openingFeeCents: Cents;
  /**
   * false : le client paie aussi son abonnement QuickBooks à Intuit. Ce coût
   * n'est pas inclus dans l'estimation (prix d'Intuit, qui change); le site
   * doit l'afficher à côté du résultat.
   */
  readonly quickbooksIncluded: boolean;
}

export type Suggestion =
  | { readonly kind: "plan"; readonly best: PlanEstimate; readonly estimates: readonly PlanEstimate[] }
  | { readonly kind: "custom_quote" };

/**
 * Simulateur du site : suggère le forfait au coût mensuel récurrent le plus
 * bas pour un dossier (transactions, et si le site les demande, comptes et
 * fréquence de TPS/TVQ). En annuel, le forfait compte pour 10/12 de son prix
 * mensuel; les suppléments restent au prix régulier. Les frais d'ouverture
 * sont donnés à part, sans entrer dans la comparaison. En cas d'égalité, le
 * forfait supérieur (plus de services). Au-delà de 150 transactions : Sur
 * mesure. Trajet n'est jamais suggéré (page Chauffeurs).
 *
 * Limite connue : l'abonnement QuickBooks que le client paie lui-même avec
 * Élan et Envol n'entre pas dans la comparaison (voir quickbooksIncluded).
 */
export function suggestPlan(
  transactions: number,
  billing: SimulatorBilling | string = "monthly",
  profile: SimulatorProfile = {},
): Suggestion {
  assertCount(transactions, "transactions");
  if (billing !== "monthly" && billing !== "annual") {
    throw new PricingError("invalid_input", `Facturation inconnue : ${billing}`);
  }
  if (transactions > SIMULATOR_MAX_TRANSACTIONS) return { kind: "custom_quote" };

  const estimates = Object.values(PLANS)
    .filter((plan) => plan.suggestedBySimulator)
    .map((plan): PlanEstimate => {
      // Mêmes calculs que pour un client inscrit aujourd'hui (grantTerms).
      const terms = grantTerms(plan.code, billing === "annual" ? "annual" : "monthly");
      const planCents = billing === "annual"
        ? prorate(plan.monthlyCents, ANNUAL_MONTHS_CHARGED, 12)
        : plan.monthlyCents;
      const extra = Math.max(0, transactions - terms.includedTransactions);
      const accountsCents = profile.accounts === undefined ? 0 : extraAccounts(terms, profile.accounts).monthlyCents;
      const filingsCents = profile.filingFrequency === undefined
        ? 0
        : prorate(filingSupplement(terms, profile.filingFrequency).annualCents, 1, 12);
      const extraTransactionsCents = extra * terms.extraTransactionCents;
      return {
        planCode: plan.code,
        includedTransactions: terms.includedTransactions,
        extraTransactions: extra,
        planCents,
        extraTransactionsCents,
        extraAccountsCents: accountsCents,
        extraFilingsCents: filingsCents,
        monthlyEstimateCents: planCents + extraTransactionsCents + accountsCents + filingsCents,
        openingFeeCents: terms.openingFeeCents,
        quickbooksIncluded: terms.quickbooksIncluded,
      };
    })
    .sort((a, b) => PLANS[a.planCode].rank - PLANS[b.planCode].rank);

  // Parcours du plus petit au plus grand : « <= » garde le supérieur en cas d'égalité.
  const best = estimates.reduce((acc, e) => (e.monthlyEstimateCents <= acc.monthlyEstimateCents ? e : acc));
  return { kind: "plan", best, estimates };
}
