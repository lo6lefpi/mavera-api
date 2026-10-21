import { addMonths, assertIsoDate, firstOfNextMonth, type IsoDate, startOfMonth } from "./dates.ts";
import { trajetEligibility, type TrajetProfile } from "./eligibility.ts";
import { PricingError } from "./errors.ts";
import { type BillingOption, BOOKS_UPDATE, type PlanCode } from "./grid.ts";
import type { Cents } from "./money.ts";
import { quebecTaxes, TAX_REGION } from "./taxes.ts";
import { type BillingCycle, commitmentEndsOn, cycleMonths, type GrantedTerms, grantTerms } from "./terms.ts";

/**
 * Le client choisit de faire traiter le mois en cours dans son forfait,
 * ou de commencer le mois suivant (le mois en cours devient alors une
 * « Mise à jour de vos livres », facturée à part).
 */
export type StartMonth = "current" | "next";

export interface CheckoutRequest {
  readonly planCode: PlanCode | string;
  readonly billingOption: BillingOption | string;
  readonly startMonth: StartMonth | string;
  /** Date du jour à Montréal. */
  readonly today: IsoDate;
  /**
   * Réponses du client aux critères de Trajet. Obligatoires pour Trajet :
   * sans elles, ou si un critère n'est pas rempli, le récapitulatif est
   * refusé et aucune session de paiement ne peut être créée.
   */
  readonly trajetProfile?: TrajetProfile;
}

export type CheckoutLineKind = "opening_fee" | "first_period";

/** Une ligne facturée : montant avant taxes, puis TPS et TVQ calculées sur cette ligne. */
export interface CheckoutLine {
  readonly kind: CheckoutLineKind;
  readonly amountCents: Cents;
  readonly gstCents: Cents;
  readonly qstCents: Cents;
}

export interface CheckoutQuote {
  readonly terms: GrantedTerms;
  /** Premier jour du premier mois couvert par le forfait (subscriptions.starts_on). */
  readonly startsOn: IsoDate;
  /** Ce qui est payé aujourd'hui. totalCents est le montant encaissé, taxes comprises. */
  readonly dueToday: {
    readonly lines: readonly CheckoutLine[];
    readonly subtotalCents: Cents;
    readonly gstCents: Cents;
    readonly qstCents: Cents;
    readonly totalCents: Cents;
  };
  /**
   * Prélèvement récurrent : amountCents avant taxes (prix de l'abonnement),
   * totalCents taxes comprises (ce qui est prélevé), cycle et date du prochain.
   */
  readonly recurring: {
    readonly amountCents: Cents;
    readonly gstCents: Cents;
    readonly qstCents: Cents;
    readonly totalCents: Cents;
    readonly cycle: BillingCycle;
    readonly nextChargeOn: IsoDate;
  };
  readonly commitmentEndsOn: IsoDate | null;
  readonly extraTransactionCents: Cents;
  /**
   * Présent si le client commence le mois suivant : le mois en cours devient
   * une mise à jour de vos livres, dont le prix part de ce minimum.
   */
  readonly currentMonthBooksUpdate: { readonly fromCents: Cents; readonly month: IsoDate } | null;
  /**
   * Taxes de vente appliquées (Québec : TPS et TVQ). Les prix des conditions
   * accordées (terms) restent avant taxes.
   */
  readonly taxRegion: typeof TAX_REGION;
}

function assertTrajetEligible(profile: TrajetProfile | undefined): void {
  if (profile === undefined) {
    throw new PricingError("invalid_input", "Trajet : les réponses aux critères d'admissibilité sont obligatoires");
  }
  const { eligible, reasons } = trajetEligibility(profile);
  if (!eligible) {
    throw new PricingError("not_eligible", "Ce dossier n'est pas admissible à Trajet : un autre forfait s'applique", reasons);
  }
}

function parseStartMonth(value: string): StartMonth {
  if (value !== "current" && value !== "next") {
    throw new PricingError("invalid_input", `Mois de départ inconnu : ${value}`);
  }
  return value;
}

/**
 * Récapitulatif avant paiement. Le site envoie des choix, jamais des montants :
 * public-api appelle cette fonction pour l'aperçu, puis pour créer la session
 * de paiement Stripe avec exactement les mêmes montants.
 *
 * Les cycles suivent le calendrier : le mois en cours est payé au complet
 * (sans prorata) et les prélèvements suivants tombent le 1er du mois.
 *
 * Stripe ne calcule rien : une session Checkout en mode abonnement avec un
 * cycle ancré au 1er facturerait un mois partiel au prorata (ou le donnerait
 * gratuitement avec proration_behavior « none », qui interdit aussi les prix
 * ponctuels comme l'ouverture). integrations/stripe encaisse donc dueToday
 * par une session Checkout en mode paiement qui enregistre le moyen de
 * paiement, puis crée l'abonnement ancré à recurring.nextChargeOn, sans
 * prorata. À valider en mode test de Stripe, y compris pour le débit
 * préautorisé.
 */
export function quoteCheckout(request: CheckoutRequest): CheckoutQuote {
  assertIsoDate(request.today);
  const startMonth = parseStartMonth(request.startMonth);
  const terms = grantTerms(request.planCode, request.billingOption);
  if (terms.planCode === "trajet") assertTrajetEligible(request.trajetProfile);

  const startsOn = startMonth === "current"
    ? startOfMonth(request.today)
    : firstOfNextMonth(request.today);

  const line = (kind: CheckoutLineKind, amount: Cents): CheckoutLine => {
    const { gstCents, qstCents } = quebecTaxes(amount);
    return { kind, amountCents: amount, gstCents, qstCents };
  };
  const lines: CheckoutLine[] = [line("opening_fee", terms.openingFeeCents)];
  let nextChargeOn: IsoDate;
  if (startMonth === "current") {
    lines.push(line("first_period", terms.recurringPriceCents));
    nextChargeOn = addMonths(startsOn, cycleMonths(terms.billingOption));
  } else {
    // Rien d'autre aujourd'hui : le premier cycle est prélevé le 1er du mois suivant.
    nextChargeOn = startsOn;
  }

  const sum = (pick: (l: CheckoutLine) => Cents) => lines.reduce((total, l) => total + pick(l), 0);
  const subtotalCents = sum(l => l.amountCents);
  const gstCents = sum(l => l.gstCents);
  const qstCents = sum(l => l.qstCents);
  const recurringTaxes = quebecTaxes(terms.recurringPriceCents);

  return {
    terms,
    startsOn,
    dueToday: { lines, subtotalCents, gstCents, qstCents, totalCents: subtotalCents + gstCents + qstCents },
    recurring: {
      amountCents: terms.recurringPriceCents,
      gstCents: recurringTaxes.gstCents,
      qstCents: recurringTaxes.qstCents,
      totalCents: recurringTaxes.totalCents,
      cycle: terms.cycle,
      nextChargeOn,
    },
    commitmentEndsOn: commitmentEndsOn(startsOn, terms.billingOption),
    extraTransactionCents: terms.extraTransactionCents,
    currentMonthBooksUpdate: startMonth === "next"
      ? { fromCents: BOOKS_UPDATE.minimumCents, month: startOfMonth(request.today) }
      : null,
    taxRegion: TAX_REGION,
  };
}
