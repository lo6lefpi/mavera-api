import { PricingError } from "./errors.ts";
import { BOOKS_UPDATE } from "./grid.ts";
import { assertCents, assertCount, type Cents } from "./money.ts";
import { coachingCharge } from "./services.ts";

export interface BooksUpdateRequest {
  /** Transactions de toute la période à mettre à jour, tous mois confondus. */
  readonly transactions: number;
  /** Déclarations de TPS/TVQ en retard à produire. */
  readonly overdueFilings?: number;
  /**
   * Accompagnement hors forfait estimé d'avance, en minutes : correction
   * d'erreurs, livres mal tenus, recherche de documents manquants.
   */
  readonly hourlyWorkMinutes?: number;
}

export type BooksUpdateLineKind = "bookkeeping" | "overdue_filings" | "hourly_work";

export interface BooksUpdateLine {
  readonly kind: BooksUpdateLineKind;
  readonly quantity: number;
  readonly amountCents: Cents;
}

export interface BooksUpdateQuote {
  readonly lines: readonly BooksUpdateLine[];
  readonly totalCents: Cents;
  /** Le minimum de 120 $ s'applique (20 transactions ou moins). */
  readonly minimumApplied: boolean;
}

/**
 * « Mise à jour de vos livres » : tarif minimum de 120 $, qui inclut les 20
 * premières transactions, puis 6 $ par transaction de plus (classement et
 * conciliation compris), + 75 $ par déclaration en retard, + l'accompagnement
 * hors forfait (60 $/h, par demi-heure) s'il faut corriger des erreurs ou
 * retrouver des documents. Le prix est confirmé au client avant de commencer,
 * par une proposition.
 */
export function quoteBooksUpdate(request: BooksUpdateRequest): BooksUpdateQuote {
  const transactions = request.transactions;
  const filings = request.overdueFilings ?? 0;
  const minutes = request.hourlyWorkMinutes ?? 0;
  assertCount(transactions, "transactions");
  assertCount(filings, "overdueFilings");
  assertCount(minutes, "hourlyWorkMinutes");

  const beyond = Math.max(0, transactions - BOOKS_UPDATE.transactionsInMinimum);
  const bookkeeping = BOOKS_UPDATE.minimumCents + beyond * BOOKS_UPDATE.perTransactionCents;
  const lines: BooksUpdateLine[] = [{ kind: "bookkeeping", quantity: transactions, amountCents: bookkeeping }];

  if (filings > 0) {
    lines.push({ kind: "overdue_filings", quantity: filings, amountCents: filings * BOOKS_UPDATE.overdueFilingCents });
  }
  if (minutes > 0) {
    const work = coachingCharge(minutes);
    lines.push({ kind: "hourly_work", quantity: work.halfHours, amountCents: work.amountCents });
  }

  return {
    lines,
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    minimumApplied: beyond === 0,
  };
}

/**
 * Étalement en 3 versements au plus. Les cents qui ne se divisent pas
 * également vont au premier versement : 100,00 $ en 3 = 33,34 + 33,33 + 33,33.
 */
export function splitInstallments(totalCents: Cents, count: number): Cents[] {
  assertCents(totalCents, "totalCents");
  if (totalCents < 0) throw new PricingError("invalid_input", "Le total ne peut pas être négatif");
  assertCount(count, "count", 1);
  if (count > BOOKS_UPDATE.maxInstallments) {
    throw new PricingError("invalid_input", `${BOOKS_UPDATE.maxInstallments} versements au plus`);
  }
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => (i === 0 ? base + remainder : base));
}
