import { assertIsoDate } from "./dates.ts";
import { COUNTER_WARNING_PERCENT } from "./grid.ts";
import { assertCents, assertCount, type Cents, formatCad } from "./money.ts";

/** Ce qu'il faut des conditions accordées pour compter un mois. */
export interface QuotaTerms {
  /** null : sans quota (Sur mesure). */
  readonly includedTransactions: number | null;
  readonly extraTransactionCents: Cents;
}

export interface MonthlyCount {
  readonly transactions: number;
  readonly included: number | null;
  readonly extraTransactions: number;
  readonly extraAmountCents: Cents;
  /** Le client approche de sa limite ou l'a dépassée. */
  readonly warning: boolean;
  /** « 17 / 20 » ou « 23 / 20 — 3 transactions supplémentaires (13,50 $) ». */
  readonly label: string;
}

/**
 * Transactions du mois par rapport au quota accordé. Le quota d'un mois est
 * celui du forfait en vigueur le dernier jour du mois (voir termsForMonth) :
 * une hausse en cours de mois profite donc au mois entier.
 */
export function countMonth(terms: QuotaTerms, transactions: number): MonthlyCount {
  assertCount(transactions, "transactions");
  assertCents(terms.extraTransactionCents, "extraTransactionCents");
  const included = terms.includedTransactions;

  if (included === null) {
    return {
      transactions,
      included: null,
      extraTransactions: 0,
      extraAmountCents: 0,
      warning: false,
      label: `${transactions} transactions`,
    };
  }

  assertCount(included, "includedTransactions", 1);
  const extra = Math.max(0, transactions - included);
  const amount = extra * terms.extraTransactionCents;
  const warning = transactions * 100 >= included * COUNTER_WARNING_PERCENT;
  const plural = extra > 1 ? "s" : "";
  const label = extra === 0
    ? `${transactions} / ${included}`
    : `${transactions} / ${included} — ${extra} transaction${plural} supplémentaire${plural} (${formatCad(amount)})`;

  return { transactions, included, extraTransactions: extra, extraAmountCents: amount, warning, label };
}

/** Période de forfait telle qu'enregistrée (subscription_plan_periods). */
export interface PlanPeriod extends QuotaTerms {
  readonly effectiveFrom: string;
  /** Exclu; null si la période est en cours. */
  readonly effectiveTo: string | null;
}

/**
 * Conditions qui s'appliquent à un mois : celles de la période en vigueur le
 * dernier jour du mois. `lastDayOfMonth` au format AAAA-MM-JJ.
 */
export function termsForMonth<T extends PlanPeriod>(periods: readonly T[], lastDayOfMonth: string): T | null {
  assertIsoDate(lastDayOfMonth);
  // Les dates AAAA-MM-JJ se comparent correctement comme des chaînes.
  return periods.find((p) =>
    p.effectiveFrom <= lastDayOfMonth && (p.effectiveTo === null || lastDayOfMonth < p.effectiveTo)
  ) ?? null;
}
