import type { BillingOption, StandardPlanCode } from '../domain/pricing/mod.ts';
import { isBillingOption, isStandardPlan } from '../domain/pricing/mod.ts';
import {
  type BillingGateway,
  type CheckoutQuote,
  type CheckoutRepository,
  InvalidRequestError,
} from './ports.ts';

export type SummaryBase = {
  planCode: StandardPlanCode;
  billingOption: BillingOption;
  currency: 'cad';
  nextCharge: { amountCents: number; on: string };
};

export type PaidSummary = SummaryBase & { paidTodayCents: number; pendingTodayCents: null };
export type PendingSummary = SummaryBase & { paidTodayCents: null; pendingTodayCents: number };
export type Summary = PaidSummary | PendingSummary;

export type CheckoutStatusResponse =
  | { status: 'unknown' }
  | { status: 'confirmed'; summary: PaidSummary }
  | { status: 'verifying'; summary: PaidSummary }
  | { status: 'processing'; summary: PendingSummary }
  | {
    status: 'rejected';
    refund:
      | { status: 'succeeded' | 'pending'; currency: 'cad'; amountCents: number }
      | { status: 'contact_required' };
  };

export function parseCheckoutSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255 || value.length <= 3 ||
    !value.startsWith('cs_') || /[^A-Za-z0-9_]/.test(value)) {
    throw new InvalidRequestError('sessionId invalide');
  }
  return value;
}

/** Liste explicite des champs publics. Les totaux enregistrés incluent TPS et TVQ. */
function summary(quote: CheckoutQuote): SummaryBase {
  if (!isStandardPlan(quote.terms.planCode) || !isBillingOption(quote.terms.billingOption)) {
    throw new Error('Récapitulatif enregistré invalide');
  }
  return {
    planCode: quote.terms.planCode,
    billingOption: quote.terms.billingOption,
    currency: 'cad',
    nextCharge: { amountCents: quote.recurring.totalCents, on: quote.recurring.nextChargeOn },
  };
}

function paidSummary(quote: CheckoutQuote): PaidSummary {
  return { ...summary(quote), paidTodayCents: quote.dueToday.totalCents, pendingTodayCents: null };
}

/**
 * Consultation seulement : aucune finalisation, reprise de webhook ou synchronisation.
 * Les ports réduits empêchent le service d'appeler une mutation métier.
 */
export async function checkoutStatus(sessionId: string, deps: {
  repository: Pick<CheckoutRepository, 'getStatusBySession'>;
  billing: Pick<BillingGateway, 'getCheckoutStatus' | 'getRefundStatus'>;
}): Promise<CheckoutStatusResponse> {
  parseCheckoutSessionId(sessionId);
  const a = await deps.repository.getStatusBySession(sessionId);
  if (!a || a.stripeSessionId !== sessionId) return { status: 'unknown' };

  if (a.rejectedAt) {
    if (!a.paidAt || !a.refundId) throw new Error('Refus sans paiement ou remboursement enregistré');
    const status = await deps.billing.getRefundStatus(a.refundId);
    if (status !== 'pending' && status !== 'succeeded') {
      return { status: 'rejected', refund: { status: 'contact_required' } };
    }
    const amountCents = a.refundAmountCents;
    if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error('Montant de remboursement absent');
    }
    return { status: 'rejected', refund: { status, currency: 'cad', amountCents } };
  }

  // Le webhook a déjà enregistré la preuve de paiement. Le dossier doit aussi exister.
  if (a.paidAt) {
    const confirmed = a.completedAt && a.dossierExists && a.paidAmountCents === a.quote.dueToday.totalCents;
    if (confirmed) return { status: 'confirmed', summary: paidSummary(a.quote) };
    return { status: 'verifying', summary: paidSummary(a.quote) };
  }

  // Avant le webhook, seule la lecture Stripe distingue l'attente bancaire du non-paiement.
  const session = await deps.billing.getCheckoutStatus(sessionId);
  if (!session || session.sessionId !== sessionId || session.attemptId !== a.id ||
    session.mode !== 'payment' || session.status !== 'complete') return { status: 'unknown' };

  if (session.paymentStatus === 'paid' && session.paymentIntentStatus === 'succeeded') {
    return { status: 'verifying', summary: paidSummary(a.quote) };
  }
  if (!a.completedAt && !a.dossierExists && session.paymentStatus === 'unpaid' &&
    session.paymentIntentStatus === 'processing') {
    return { status: 'processing', summary: {
      ...summary(a.quote), paidTodayCents: null, pendingTodayCents: a.quote.dueToday.totalCents,
    } };
  }
  return { status: 'unknown' };
}
