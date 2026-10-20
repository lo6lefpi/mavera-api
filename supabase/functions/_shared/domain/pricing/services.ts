import { PricingError } from "./errors.ts";
import { COACHING, type FilingFrequency, isFilingFrequency, type PlanCode, STANDALONE_FILING_CENTS } from "./grid.ts";
import { assertCents, assertCount, type Cents, prorate } from "./money.ts";

const FILINGS_PER_YEAR: Readonly<Record<FilingFrequency, number>> = {
  annual: 1,
  quarterly: 4,
  monthly: 12,
};

/**
 * Ce qu'il faut des conditions accordées (une ligne de
 * subscription_plan_periods) pour calculer les suppléments. Les valeurs
 * nulles viennent d'un forfait Sur mesure : elles sont fixées par la soumission.
 */
export interface SupplementTerms {
  readonly planCode: PlanCode | string;
  readonly includedAccounts: number | null;
  readonly extraAccountCents: Cents;
  readonly includedFilingFrequency: FilingFrequency | null;
  readonly extraFilingCents: Cents;
}

function custom(what: string): PricingError {
  return new PricingError("not_priced", `${what} : selon la soumission Sur mesure`);
}

export interface FilingSupplement {
  readonly includedFrequency: FilingFrequency;
  readonly clientFrequency: FilingFrequency;
  /** Déclarations de plus que la fréquence incluse, par année. */
  readonly extraFilingsPerYear: number;
  readonly perFilingCents: Cents;
  readonly annualCents: Cents;
}

/**
 * La fréquence de TPS/TVQ est fixée par Revenu Québec, pas par le forfait.
 * Chaque déclaration au-delà de la fréquence incluse coûte le prix accordé
 * (25 $ dans la grille 2026-10). Ex. Envol (trimestrielle incluse) avec un
 * client mensuel : 8 déclarations de plus par an.
 */
export function filingSupplement(terms: SupplementTerms, clientFrequency: FilingFrequency | string): FilingSupplement {
  if (!isFilingFrequency(clientFrequency)) {
    throw new PricingError("invalid_input", `Fréquence inconnue : ${clientFrequency}`);
  }
  if (terms.includedFilingFrequency === null) throw custom("Déclarations");
  assertCents(terms.extraFilingCents, "extraFilingCents");
  const extra = Math.max(0, FILINGS_PER_YEAR[clientFrequency] - FILINGS_PER_YEAR[terms.includedFilingFrequency]);
  return {
    includedFrequency: terms.includedFilingFrequency,
    clientFrequency,
    extraFilingsPerYear: extra,
    perFilingCents: terms.extraFilingCents,
    annualCents: extra * terms.extraFilingCents,
  };
}

export interface ExtraAccounts {
  readonly includedAccounts: number;
  readonly extraAccounts: number;
  /** Prix unitaire par mois (subscription_add_ons.recurring_price_cents). */
  readonly unitMonthlyCents: Cents;
  readonly monthlyCents: Cents;
}

/**
 * Comptes bancaires ou cartes au-delà de ceux inclus, au prix accordé
 * (15 $ par mois chacun dans la grille 2026-10).
 * Trajet exige un seul compte : au-delà, le client n'y est pas admissible.
 */
export function extraAccounts(terms: SupplementTerms, accounts: number): ExtraAccounts {
  assertCount(accounts, "accounts");
  if (terms.includedAccounts === null) throw custom("Comptes");
  assertCents(terms.extraAccountCents, "extraAccountCents");
  const extra = Math.max(0, accounts - terms.includedAccounts);
  if (terms.planCode === "trajet" && extra > 0) {
    throw new PricingError("not_eligible", "Trajet est réservé aux dossiers avec un seul compte");
  }
  return {
    includedAccounts: terms.includedAccounts,
    extraAccounts: extra,
    unitMonthlyCents: terms.extraAccountCents,
    monthlyCents: extra * terms.extraAccountCents,
  };
}

/**
 * Prix unitaire d'une option (codes de la table add_ons), selon les
 * conditions accordées au client.
 */
export function addOnUnitPrice(code: string, terms: SupplementTerms): Cents {
  switch (code) {
    case "extra_account":
      return terms.extraAccountCents;
    case "more_frequent_filings":
      return terms.extraFilingCents;
    case "client_invoicing":
      throw new PricingError("not_priced", "Le suivi des factures clients n'a pas encore de prix fixe");
    default:
      throw new PricingError("invalid_input", `Option inconnue : ${code}`);
  }
}

/**
 * « Accompagnement hors forfait » : 60 $/h, facturé par demi-heure entamée.
 * Les questions sur le dossier, l'appel de bienvenue et les échanges dans
 * l'application restent inclus : ils ne passent jamais par ici.
 */
export function coachingCharge(minutes: number): { halfHours: number; amountCents: Cents } {
  assertCount(minutes, "minutes", 1);
  const halfHours = Math.ceil(minutes / COACHING.incrementMinutes);
  const perIncrement = prorate(COACHING.hourlyCents, COACHING.incrementMinutes, 60);
  return { halfHours, amountCents: halfHours * perIncrement };
}

/** Déclaration de TPS/TVQ seule (chiffres prêts), pour une personne sans forfait. */
export function standaloneFilingPrice(): Cents {
  return STANDALONE_FILING_CENTS;
}
