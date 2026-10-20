import { assertIsoDate, compareDates, type IsoDate } from "./dates.ts";
import { PricingError } from "./errors.ts";
import type { BillingOption } from "./grid.ts";
import { assertCents, type Cents } from "./money.ts";
import { commitmentEndsOn } from "./terms.ts";

/** Mêmes valeurs que l'enum public.close_reason. */
export type CloseReason =
  | "no_response"
  | "declined_proposal"
  | "refund_before_call"
  | "client_request"
  | "end_of_mandate"
  | "non_payment"
  | "previously_refused"
  | "other";

const CLOSE_REASONS: readonly CloseReason[] = [
  "no_response",
  "declined_proposal",
  "refund_before_call",
  "client_request",
  "end_of_mandate",
  "non_payment",
  "previously_refused",
  "other",
];

export interface CommitmentTerms {
  readonly billingOption: BillingOption;
  /** subscriptions.starts_on */
  readonly startsOn: IsoDate;
  /** subscriptions.opening_discount_cents */
  readonly openingDiscountCents: Cents;
}

export interface TerminationFee {
  readonly feeCents: Cents;
  readonly commitmentEndsOn: IsoDate | null;
  readonly reason: "no_commitment" | "commitment_completed" | "no_fee_for_reason" | "early_cancellation";
}

/**
 * Ce que doit un client dont le dossier est fermé avant la fin de son
 * engagement de 12 mois. Règle publiée sur le site (FAQ « Y a-t-il un
 * engagement ? ») : en cas d'annulation avant la fin, le rabais obtenu sur
 * l'ouverture est facturé. Elle ne s'applique que si le client part de
 * lui-même (client_request) : une fermeture décidée par la firme, faute de
 * réponse ou après un refus de proposition, met fin à l'engagement sans
 * autres frais. Le non-paiement suit le recouvrement normal, pas cette règle.
 *
 * Un client annuel qui part avant la fin n'est pas remboursé des mois
 * restants (à écrire dans le contrat de services). Règles confirmées le
 * 20 octobre 2026.
 */
export function earlyTerminationFee(terms: CommitmentTerms, closeOn: IsoDate, closeReason: CloseReason | string): TerminationFee {
  assertIsoDate(closeOn);
  assertCents(terms.openingDiscountCents, "openingDiscountCents");
  if (!(CLOSE_REASONS as readonly string[]).includes(closeReason)) {
    throw new PricingError("invalid_input", `Motif de fermeture inconnu : ${closeReason}`);
  }
  const endsOn = commitmentEndsOn(terms.startsOn, terms.billingOption);
  if (endsOn === null) return { feeCents: 0, commitmentEndsOn: null, reason: "no_commitment" };
  if (compareDates(closeOn, endsOn) >= 0) return { feeCents: 0, commitmentEndsOn: endsOn, reason: "commitment_completed" };
  if (closeReason !== "client_request") return { feeCents: 0, commitmentEndsOn: endsOn, reason: "no_fee_for_reason" };
  return { feeCents: terms.openingDiscountCents, commitmentEndsOn: endsOn, reason: "early_cancellation" };
}
