import { addMonths, assertIsoDate, compareDates, daysBetween, firstOfNextMonth, type IsoDate } from "./dates.ts";
import { PricingError } from "./errors.ts";
import type { BillingOption, PlanCode, StandardPlanCode } from "./grid.ts";
import { assertCents, type Cents, prorate } from "./money.ts";
import { cycleMonths, type GrantedTerms, getPlan, grantTerms } from "./terms.ts";

/*
 * Qui calcule le prorata : ce module, jamais Stripe.
 * Le client voit le montant exact dans la proposition avant d'accepter; Stripe
 * doit facturer exactement ce montant. integrations/stripe met donc à jour
 * l'abonnement avec proration_behavior « none » et facture les montants
 * calculés ici en lignes de facture séparées (ou les rembourse). Un test
 * d'intégration en mode test de Stripe devra comparer les factures produites
 * à ces montants.
 */

/** L'abonnement actuel, lu dans la base et dans Stripe. */
export interface CurrentSubscription {
  readonly planCode: StandardPlanCode;
  readonly billingOption: BillingOption;
  /** Prix accordé par cycle (peut venir d'une ancienne grille). */
  readonly recurringPriceCents: Cents;
  /**
   * Premier jour du cycle en cours (le 1er du mois, ou le début de l'année
   * payée). Pour un client qui commence le mois suivant, le premier cycle
   * n'a pas encore commencé : cette date est dans le futur.
   */
  readonly cycleStartsOn: IsoDate;
  /**
   * Sommes réellement encaissées, nettes des remboursements déjà faits,
   * lues dans Stripe : jamais déduites de la grille.
   */
  readonly collected: {
    readonly openingFeeCents: Cents;
    /** Montant encaissé pour le cycle en cours; 0 s'il n'a pas commencé ou n'est pas payé. */
    readonly currentCycleCents: Cents;
  };
}

export type PlanChangeDirection = "upgrade" | "downgrade" | "same";

export function planChangeDirection(from: PlanCode | string, to: PlanCode | string): PlanChangeDirection {
  const a = getPlan(from).rank;
  const b = getPlan(to).rank;
  return b > a ? "upgrade" : b < a ? "downgrade" : "same";
}

type CycleState = { started: false; start: IsoDate } | { started: true; start: IsoDate; end: IsoDate };

function cycleState(current: CurrentSubscription, today: IsoDate): CycleState {
  assertIsoDate(today);
  assertIsoDate(current.cycleStartsOn);
  assertCents(current.recurringPriceCents, "recurringPriceCents");
  assertCents(current.collected.openingFeeCents, "collected.openingFeeCents");
  assertCents(current.collected.currentCycleCents, "collected.currentCycleCents");
  const start = current.cycleStartsOn;
  if (compareDates(today, start) < 0) return { started: false, start };
  const end = addMonths(start, cycleMonths(current.billingOption));
  if (compareDates(today, end) >= 0) {
    throw new PricingError("invalid_input", `La date ${today} n'est pas dans le cycle en cours`);
  }
  return { started: true, start, end };
}

function assertDirection(current: CurrentSubscription, target: PlanCode | string, wanted: "upgrade" | "downgrade"): void {
  const direction = planChangeDirection(current.planCode, target);
  if (direction === wanted) return;
  if (direction === "same") throw new PricingError("same_plan", "Le forfait demandé est le forfait actuel");
  throw new PricingError(
    wanted === "upgrade" ? "not_an_upgrade" : "not_a_downgrade",
    wanted === "upgrade" ? "Ce changement n'est pas une hausse" : "Ce changement n'est pas une baisse",
  );
}

export interface UpgradeQuote {
  readonly newTerms: GrantedTerms;
  /** Aujourd'hui, ou le début du premier cycle s'il n'a pas encore commencé. */
  readonly effectiveFrom: IsoDate;
  /** Différence de prix pour les jours qui restent dans le cycle, aujourd'hui compris. */
  readonly prorataCents: Cents;
  /** Frais d'ouverture du nouveau forfait moins ceux déjà encaissés. */
  readonly openingDifferenceCents: Cents;
  readonly totalDueCents: Cents;
  readonly remainingDays: number;
  readonly cycleDays: number;
}

/**
 * Hausse de forfait : tout de suite, avec un prorata pour le cycle en cours et
 * la différence de frais d'ouverture. L'option de facturation ne change pas.
 * Si le premier cycle n'a pas commencé, seule la différence d'ouverture est
 * due aujourd'hui : le nouveau prix sera prélevé au début du cycle.
 */
export function quoteUpgrade(current: CurrentSubscription, targetPlan: PlanCode | string, today: IsoDate): UpgradeQuote {
  const cycle = cycleState(current, today);
  assertDirection(current, targetPlan, "upgrade");

  const newTerms = grantTerms(targetPlan, current.billingOption);
  const openingDifferenceCents = Math.max(0, newTerms.openingFeeCents - current.collected.openingFeeCents);

  if (!cycle.started) {
    return {
      newTerms,
      effectiveFrom: cycle.start,
      prorataCents: 0,
      openingDifferenceCents,
      totalDueCents: openingDifferenceCents,
      remainingDays: 0,
      cycleDays: 0,
    };
  }

  const cycleDays = daysBetween(cycle.start, cycle.end);
  const remainingDays = daysBetween(today, cycle.end);
  const priceDifference = Math.max(0, newTerms.recurringPriceCents - current.recurringPriceCents);
  const prorataCents = prorate(priceDifference, remainingDays, cycleDays);

  return {
    newTerms,
    effectiveFrom: today,
    prorataCents,
    openingDifferenceCents,
    totalDueCents: prorataCents + openingDifferenceCents,
    remainingDays,
    cycleDays,
  };
}

export interface DowngradeQuote {
  readonly newTerms: GrantedTerms;
  readonly effectiveFrom: IsoDate;
  /** Rien n'est remboursé : le cycle déjà payé se termine avec l'ancien forfait. */
  readonly refundCents: 0;
}

/**
 * Baisse de forfait : au début du mois suivant. Pour un client annuel, à la
 * fin de l'année déjà payée, sans remboursement (décision du 20 octobre 2026).
 * Si le premier cycle n'a pas commencé, la baisse s'applique dès son début.
 */
export function quoteDowngrade(current: CurrentSubscription, targetPlan: PlanCode | string, today: IsoDate): DowngradeQuote {
  const cycle = cycleState(current, today);
  assertDirection(current, targetPlan, "downgrade");
  const newTerms = grantTerms(targetPlan, current.billingOption);

  let effectiveFrom: IsoDate;
  if (!cycle.started) effectiveFrom = cycle.start;
  else if (current.billingOption === "annual") effectiveFrom = cycle.end;
  else effectiveFrom = firstOfNextMonth(today);

  return { newTerms, effectiveFrom, refundCents: 0 };
}

export interface WelcomeCallDowngradeQuote {
  readonly newTerms: GrantedTerms;
  readonly effectiveFrom: IsoDate;
  readonly refundCents: Cents;
  /** Ouverture encaissée moins l'ouverture du nouveau forfait. */
  readonly openingRefundCents: Cents;
  /** Cycle encaissé moins le prix du nouveau forfait; 0 si rien n'a été encaissé. */
  readonly cycleRefundCents: Cents;
}

/**
 * Exception : une baisse décidée à l'appel de bienvenue s'applique tout de
 * suite, avec le remboursement de la différence, puisqu'aucun travail n'a
 * commencé. Le remboursement part des sommes réellement encaissées : on ne
 * rembourse jamais un cycle qui n'a pas été payé.
 *
 * `workStarted` vient de l'état du dossier (mandate_status) : vrai dès que le
 * dossier est actif. Le remboursement est alors refusé, et la baisse suit la
 * règle normale (quoteDowngrade).
 */
export function quoteWelcomeCallDowngrade(
  current: CurrentSubscription,
  targetPlan: PlanCode | string,
  today: IsoDate,
  workStarted: boolean,
): WelcomeCallDowngradeQuote {
  const cycle = cycleState(current, today);
  assertDirection(current, targetPlan, "downgrade");
  if (workStarted) {
    throw new PricingError("work_started", "Le travail a commencé : la baisse suit la règle normale, sans remboursement");
  }
  const newTerms = grantTerms(targetPlan, current.billingOption);

  const openingRefundCents = Math.max(0, current.collected.openingFeeCents - newTerms.openingFeeCents);
  const cycleRefundCents = cycle.started && current.collected.currentCycleCents > 0
    ? Math.max(0, current.collected.currentCycleCents - newTerms.recurringPriceCents)
    : 0;

  return {
    newTerms,
    effectiveFrom: cycle.started ? today : cycle.start,
    refundCents: openingRefundCents + cycleRefundCents,
    openingRefundCents,
    cycleRefundCents,
  };
}
