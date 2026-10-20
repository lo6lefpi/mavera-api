import { BillingTerminalError, type BillingGateway, type CheckoutRepository, type CheckoutAttempt } from './ports.ts';

const rejectedCode = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  const details = 'details' in error && error.details && typeof error.details === 'object' ? error.details : null;
  const sqlstate = details && 'code' in details ? String(details.code) : '';
  return ['P0003', 'P0004'].includes(code) || ['P0003', 'P0004'].includes(sqlstate);
};

async function compensate(attempt: CheckoutAttempt, token: string, reason: string,
  deps: { billing: BillingGateway; repository: CheckoutRepository }): Promise<void> {
  if (!attempt.stripePaymentIntentId) throw new Error('Remboursement impossible : PaymentIntent absent');
  if (attempt.stripeSubscriptionId) {
    await deps.billing.cancelSubscription(attempt.stripeSubscriptionId, attempt.id);
  }
  const refundId = await deps.billing.refund({
    attemptId: attempt.id, paymentIntentId: attempt.stripePaymentIntentId, reason,
  });
  await deps.repository.reject(attempt.id, token, refundId, reason);
}

/** Seul le webhook appelle cette fonction. La quote n'est jamais recalculée. */
export async function completeCheckout(
  attemptId: string, eventId: string,
  deps: { billing: BillingGateway; repository: CheckoutRepository },
  now = new Date(),
): Promise<'pending' | 'busy' | 'completed' | 'already_completed' | 'rejected'> {
  const token = crypto.randomUUID();
  if (!await deps.repository.claim(attemptId, token)) return 'busy';
  try {
    let a = await deps.repository.getAttempt(attemptId);
    if (!a) throw new Error('Tentative inconnue');
    if (a.completedAt) return 'already_completed';
    if (a.rejectedAt) return 'rejected';
    if (!a.stripeSessionId) throw new Error('Session Stripe non enregistrée');
    const proof = await deps.billing.getPaymentProof(a.stripeSessionId);
    if (proof.attemptId !== attemptId || proof.sessionId !== a.stripeSessionId) {
      throw new Error('Incohérence de la session Stripe');
    }
    if (!proof.paid) return 'pending';
    if (!proof.customerId || !proof.paymentIntentId || !proof.paymentMethodId || !proof.paidAt) {
      throw new Error('Moyen de paiement récurrent indisponible');
    }
    if (proof.currency !== 'cad' || proof.amountPaidCents !== a.quote.dueToday.totalCents) {
      throw new Error('Paiement reçu non conforme aux conditions accordées');
    }
    await deps.repository.savePayment(attemptId, token, proof);
    a = (await deps.repository.getAttempt(attemptId))!;
    const eligibility = await deps.repository.checkEligibility(a.email, a.phone, proof.customerId);
    if (eligibility === 'active' || eligibility === 'refused') {
      await compensate(a, token, `inscription_${eligibility}`, deps);
      return 'rejected';
    }
    let sub = a.stripeSubscriptionId
      ? { subscriptionId: a.stripeSubscriptionId, priceId: a.stripePriceId!, status: a.stripeStatus! }
      : await deps.billing.findSubscriptionForAttempt(proof.customerId, attemptId);
    if (!sub) {
      try {
        sub = await deps.billing.createSubscription({
          attemptId, customerId: proof.customerId, paymentMethodId: proof.paymentMethodId,
          recurringLookupKey: a.quote.terms.stripeRecurringLookupKey,
          recurringPriceCents: a.quote.recurring.amountCents,
          cycle: a.quote.recurring.cycle,
          anchorOn: a.quote.recurring.nextChargeOn,
          paidAt: proof.paidAt,
        });
      } catch (error) {
        if (!(error instanceof BillingTerminalError)) throw error;
        await compensate(a, token, error.reason, deps);
        return 'rejected';
      }
    }
    if (!a.stripeSubscriptionId) await deps.repository.saveSubscription(attemptId, token, sub);
    try {
      await deps.repository.complete(attemptId, token, eventId,
        new Date(now.getTime() + 7 * 86_400_000).toISOString());
    } catch (error) {
      if (!rejectedCode(error)) throw error;
      a = (await deps.repository.getAttempt(attemptId))!;
      await compensate(a, token, 'identite_refusee_ou_mandat_existant', deps);
      return 'rejected';
    }
    return 'completed';
  } finally {
    await deps.repository.release(attemptId, token);
  }
}
