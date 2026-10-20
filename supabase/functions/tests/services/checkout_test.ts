// deno-lint-ignore-file require-await -- faux dépôt : mêmes signatures async que le vrai, sans attente réelle.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CheckoutAttempt, CheckoutQuote, Eligibility, PaymentProof, SignupInput, RefundResult,
  RefundSignal, StripeSubscriptionRecord, SubscriptionState, CheckoutRepository } from '../../_shared/services/ports.ts';
import { SignupError } from '../../_shared/services/ports.ts';
import { startCheckout, prepareQuote } from '../../_shared/services/start-checkout.ts';
import { completeCheckout } from '../../_shared/services/complete-checkout.ts';
import { syncRefund, syncSubscription } from '../../_shared/services/sync-billing.ts';
import { FakeStripeGateway } from '../../_shared/integrations/stripe/fake-gateway.ts';
import { torontoMidnight } from '../../_shared/integrations/stripe/time.ts';

const input = (extra: Partial<SignupInput> = {}): SignupInput => ({
  attemptId: '7fc50a4e-ec4b-47e3-998a-3d5f99e55b91', email: 'Test@Example.ca', phone: '5145550100',
  displayName: 'Test Co', planCode: 'depart', billingOption: 'monthly',
  startMonth: 'current', booksUpToDate: true, usesQuickbooks: false,
  estimatedTransactions: 14, successUrl: 'https://example.ca/success', cancelUrl: 'https://example.ca/cancel', ...extra,
});
const SECOND = '0b6d9f0e-3c1a-4f7e-9a51-6c2d8e4f1a20';

/** Mêmes règles que les fonctions SQL, en mémoire. */
class FakeRepository implements CheckoutRepository {
  attempts = new Map<string, CheckoutAttempt>();
  eligibility: Eligibility = 'new';
  token: string | null = null;
  completeCalls = 0;
  failOnce = false;
  reasons = new Map<string, string>();
  refundStatus = new Map<string, string>();
  states: SubscriptionState[] = [];
  checkEligibility(): Promise<Eligibility> { return Promise.resolve(this.eligibility); }
  async createAttempt(i: SignupInput, quote: CheckoutQuote) {
    if (await this.openAttemptFor(i.email)) throw new Error('P0005 tentative ouverte');
    const attempt: CheckoutAttempt = { id: i.attemptId, createdAt: new Date().toISOString(),
      email: i.email, phone: i.phone, displayName: i.displayName,
      booksUpToDate: i.booksUpToDate, usesQuickbooks: i.usesQuickbooks,
      estimatedTransactions: i.estimatedTransactions, quote,
      stripeSessionId: null, stripeCustomerId: null, stripePaymentIntentId: null,
      stripeSubscriptionId: null, stripePriceId: null, stripeStatus: null, paidAmountCents: null,
      paidAt: null, completedAt: null, rejectedAt: null, abandonedAt: null, refundId: null };
    this.attempts.set(i.attemptId, attempt); return attempt;
  }
  getAttempt(id: string) { return Promise.resolve(this.attempts.get(id) ?? null); }
  openAttemptFor(email: string) {
    const open = [...this.attempts.values()].find(a => a.email === email &&
      !a.completedAt && !a.rejectedAt && !a.abandonedAt);
    return Promise.resolve(open?.id ?? null);
  }
  async abandon(id: string) {
    const a = this.attempts.get(id)!;
    if (a.paidAt || this.token) throw new Error('P0001 tentative payée ou verrouillée');
    a.abandonedAt = new Date().toISOString();
  }
  async saveSession(id: string, sessionId: string) { this.attempts.get(id)!.stripeSessionId = sessionId; }
  async claim(_id: string, token: string) { if (this.token) return false; this.token = token; return true; }
  async savePayment(id: string, _token: string, proof: PaymentProof) {
    const a = this.attempts.get(id)!;
    a.stripeCustomerId = proof.customerId; a.stripePaymentIntentId = proof.paymentIntentId;
    a.paidAt = proof.paidAt; a.paidAmountCents = proof.amountPaidCents;
  }
  async saveSubscription(id: string, _token: string, s: StripeSubscriptionRecord) {
    const a = this.attempts.get(id)!;
    a.stripeSubscriptionId = s.subscriptionId; a.stripePriceId = s.priceId; a.stripeStatus = s.status;
  }
  async complete(id: string) {
    this.completeCalls++;
    if (this.failOnce) { this.failOnce = false; throw new Error('temporary SQL failure'); }
    this.attempts.get(id)!.completedAt = new Date().toISOString();
    return 'client_id';
  }
  async reject(id: string, _token: string, refund: RefundResult, reason: string) {
    const a = this.attempts.get(id)!;
    // Mêmes exigences que checkout_attempt_reject.
    if (!['pending', 'succeeded'].includes(refund.status) || refund.amountCents !== a.paidAmountCents) {
      throw new Error('22023 remboursement non conforme');
    }
    a.rejectedAt = new Date().toISOString(); a.refundId = refund.refundId;
    this.reasons.set(id, reason); this.refundStatus.set(refund.refundId, refund.status);
  }
  async release() { this.token = null; }
  async applySubscriptionState(state: SubscriptionState) { this.states.push(state); return true; }
  async updateRefundStatus(signal: RefundSignal) {
    if (!this.refundStatus.has(signal.refundId)) return false;
    this.refundStatus.set(signal.refundId, signal.status); return true;
  }
}
const deps = (repo: FakeRepository, stripe: FakeStripeGateway) => ({ repository: repo, billing: stripe });
const signupError = (code: string) => (error: unknown) => error instanceof SignupError && error.code === code;

test('prix mensuel courant fourni par pricing, aucun recalcul Stripe', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  const result = await startCheckout(input(), { repository: repo, billing: stripe }, '2026-10-31');
  assert.equal(result.quote.dueToday.totalCents, 17800);
  assert.equal(result.quote.recurring.nextChargeOn, '2026-11-01');
  assert.equal(result.quote.terms.stripeRecurringLookupKey, 'depart_monthly_2026_10');
  assert.equal(result.quote.dueToday.lines.length, 2);
});

test('mois suivant : frais d’ouverture uniquement, prélèvement 1er prochain', () => {
  const quote = prepareQuote(input({ startMonth: 'next' }), '2026-10-20');
  assert.equal(quote.dueToday.totalCents, 9900);
  assert.equal(quote.recurring.nextChargeOn, '2026-11-01');
  assert.equal(quote.currentMonthBooksUpdate?.fromCents, 12000);
});

test('Trajet non admissible ou critères absents bloqués avant paiement', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  await assert.rejects(startCheckout(input({planCode:'trajet'}), {repository:repo, billing:stripe},'2026-10-20'));
  assert.equal(stripe.checkoutCreates, 0);
  assert.throws(() => prepareQuote(input({planCode:'trajet', trajetProfile:{
    platformIncomeOnly:false, accounts:1, issuesClientInvoices:false,monthlyTransactions:14,
  }}), '2026-10-20'));
});

test('paiement en attente, webhook répété, inscription créée une fois', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway(); stripe.nextPaid = false;
  await startCheckout(input(),{repository:repo,billing:stripe},'2026-10-20');
  assert.equal(await completeCheckout(input().attemptId,'evt_a',{repository:repo,billing:stripe}), 'pending');
  stripe.sessions.get(`cs_test_${input().attemptId}`)!.paid = true;
  assert.equal(await completeCheckout(input().attemptId,'evt_b',{repository:repo,billing:stripe}), 'completed');
  assert.equal(await completeCheckout(input().attemptId,'evt_b',{repository:repo,billing:stripe}), 'already_completed');
  assert.equal(stripe.subscriptionCreates,1);
  assert.equal(repo.completeCalls,1);
});

test('erreur SQL transitoire après abonnement : reprise sans abonnement supplémentaire', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway(); repo.failOnce = true;
  await startCheckout(input(),{repository:repo,billing:stripe},'2026-10-20');
  await assert.rejects(completeCheckout(input().attemptId,'evt_z',{repository:repo,billing:stripe}));
  assert.equal(stripe.subscriptionCreates,1);
  assert.equal(await completeCheckout(input().attemptId,'evt_z',{repository:repo,billing:stripe}), 'completed');
  assert.equal(stripe.subscriptionCreates,1);
});

test('client refusé après paiement : remboursement sans abonnement', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  await startCheckout(input(),{repository:repo,billing:stripe},'2026-10-20');
  repo.eligibility='refused';
  assert.equal(await completeCheckout(input().attemptId,'evt_refus',{repository:repo,billing:stripe}), 'rejected');
  assert.equal(stripe.refunds.size,1); assert.equal(stripe.subscriptionCreates,0);
});

test('annuel renouvelé 12 mois plus tard, et Trajet sans annuel', () => {
  const quote = prepareQuote(input({ planCode:'envol', billingOption:'annual' }), '2026-10-20');
  assert.equal(quote.dueToday.totalCents, 258900);
  assert.equal(quote.recurring.nextChargeOn, '2027-10-01');
  assert.equal(quote.terms.stripeRecurringLookupKey, 'envol_annual_2026_10');
  assert.throws(() => prepareQuote(input({ planCode:'trajet', billingOption:'annual' }), '2026-10-20'));
});

test('payé avant minuit, webhook traité après : cycle suivant, mois facturé, aucun remboursement', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  stripe.nowSeconds = torontoMidnight('2026-10-31') + 20 * 3600;          // 31 octobre, 20 h
  await startCheckout(input(),{repository:repo,billing:stripe},'2026-10-31');
  stripe.nowSeconds = torontoMidnight('2026-11-01') + 3600;               // traité le 1er novembre, 1 h
  assert.equal(await completeCheckout(input().attemptId,'evt_late',{repository:repo,billing:stripe}), 'completed');
  const sub = stripe.subscriptions.get(`sub_${input().attemptId}`)!;
  assert.equal(sub.anchorOn, '2026-12-01');
  assert.equal(sub.immediateInvoiceCents, 7900);
  assert.equal(stripe.refunds.size, 0);
});

test('payé après l\'ancrage : remboursement, aucun abonnement', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  stripe.nowSeconds = torontoMidnight('2026-10-31') + 20 * 3600;
  stripe.paidAt = new Date((torontoMidnight('2026-11-01') + 60) * 1000).toISOString();
  await startCheckout(input(),{repository:repo,billing:stripe},'2026-10-31');
  stripe.nowSeconds = torontoMidnight('2026-11-01') + 600;
  assert.equal(await completeCheckout(input().attemptId,'evt_after',{repository:repo,billing:stripe}), 'rejected');
  assert.equal(stripe.refunds.size, 1);
  assert.equal(stripe.subscriptionCreates, 0);
});

test('dernière demi-heure du mois : aucune session de paiement', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  stripe.nowSeconds = torontoMidnight('2026-11-01') - 20 * 60;            // 31 octobre, 23 h 40
  await assert.rejects(startCheckout(input(),{repository:repo,billing:stripe},'2026-10-31'), /checkout_window_closed/);
  assert.equal(stripe.checkoutCreates, 0);
});

test('une tentative identique récupère la même session et le même devis', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  const a = await startCheckout(input(),{repository:repo,billing:stripe},'2026-10-20');
  const b = await startCheckout(input(),{repository:repo,billing:stripe},'2026-10-21');
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(b.quote.startsOn,'2026-10-01');
  assert.equal(stripe.checkoutCreates, 1);
});

test('ancien client : renvoyé vers l\'application, aucune session ni client Stripe', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway(); repo.eligibility = 'returning';
  await assert.rejects(startCheckout(input(), deps(repo, stripe), '2026-10-20'), signupError('returning_client'));
  repo.eligibility = 'active';
  await assert.rejects(startCheckout(input(), deps(repo, stripe), '2026-10-20'), signupError('not_allowed'));
  assert.equal(stripe.checkoutCreates, 0);
  assert.equal(repo.attempts.size, 0);
});

test('nouvelle demande pour le même courriel : l\'ancienne session expire, puis est abandonnée', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  const first = await startCheckout(input(), deps(repo, stripe), '2026-10-20');
  const second = await startCheckout(input({ attemptId: SECOND, planCode: 'elan' }), deps(repo, stripe), '2026-10-20');
  assert.equal(stripe.sessionStatus.get(first.sessionId), 'expired');
  assert.ok(repo.attempts.get(input().attemptId)!.abandonedAt);
  assert.equal(await repo.openAttemptFor('test@example.ca'), SECOND);
  assert.notEqual(first.sessionId, second.sessionId);
});

test('ancienne demande déjà payée, ou payée pendant le remplacement : aucun deuxième paiement', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  const first = await startCheckout(input(), deps(repo, stripe), '2026-10-20');
  stripe.sessionStatus.set(first.sessionId, 'complete');           // payée chez Stripe, webhook pas encore traité
  await assert.rejects(startCheckout(input({ attemptId: SECOND }), deps(repo, stripe), '2026-10-20'),
    signupError('payment_in_progress'));
  assert.equal(repo.attempts.get(input().attemptId)!.abandonedAt, null);
  assert.equal(await completeCheckout(input().attemptId, 'evt_paid', deps(repo, stripe)), 'completed');

  const repo2 = new FakeRepository(); const stripe2 = new FakeStripeGateway();
  await startCheckout(input(), deps(repo2, stripe2), '2026-10-20');
  repo2.attempts.get(input().attemptId)!.paidAt = new Date().toISOString();   // paiement enregistré
  await assert.rejects(startCheckout(input({ attemptId: SECOND }), deps(repo2, stripe2), '2026-10-20'),
    signupError('payment_in_progress'));
  assert.equal(stripe2.checkoutCreates, 1);
});

test('remboursement échoué ou partiel : rien n\'est enregistré, la reprise rembourse au complet', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  await startCheckout(input(), deps(repo, stripe), '2026-10-20');
  repo.eligibility = 'refused';
  stripe.nextRefundStatus = 'failed';
  await assert.rejects(completeCheckout(input().attemptId, 'evt_r1', deps(repo, stripe)), /non accepté/);
  assert.equal(repo.attempts.get(input().attemptId)!.rejectedAt, null);

  stripe.nextRefundStatus = 'pending'; stripe.nextRefundAmountCents = 100;
  await assert.rejects(completeCheckout(input().attemptId, 'evt_r2', deps(repo, stripe)), /incomplet/);
  assert.equal(repo.attempts.get(input().attemptId)!.rejectedAt, null);

  stripe.nextRefundAmountCents = null;
  stripe.refunds.get(input().attemptId)!.status = 'canceled';      // le partiel a été annulé
  assert.equal(await completeCheckout(input().attemptId, 'evt_r3', deps(repo, stripe)), 'rejected');
  const a = repo.attempts.get(input().attemptId)!;
  assert.equal(stripe.refunds.get(input().attemptId)!.amountCents, a.paidAmountCents);
  assert.equal(stripe.refundCreates, 3);
  assert.equal(await completeCheckout(input().attemptId, 'evt_r3', deps(repo, stripe)), 'rejected');
  assert.equal(stripe.refundCreates, 3);
});

test('ancien client détecté au paiement, ou paiement après abandon : remboursé, aucun abonnement', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  await startCheckout(input(), deps(repo, stripe), '2026-10-20');
  repo.eligibility = 'returning';
  assert.equal(await completeCheckout(input().attemptId, 'evt_ret', deps(repo, stripe)), 'rejected');
  assert.equal(repo.reasons.get(input().attemptId), 'inscription_returning');

  const repo2 = new FakeRepository(); const stripe2 = new FakeStripeGateway();
  await startCheckout(input(), deps(repo2, stripe2), '2026-10-20');
  repo2.attempts.get(input().attemptId)!.abandonedAt = new Date().toISOString();
  assert.equal(await completeCheckout(input().attemptId, 'evt_ab', deps(repo2, stripe2)), 'rejected');
  assert.equal(repo2.reasons.get(input().attemptId), 'paye_apres_abandon');
  assert.equal(stripe2.refunds.get(input().attemptId)!.amountCents, 17800);
  assert.equal(stripe2.subscriptionCreates, 0);
  assert.equal(stripe.subscriptionCreates, 0);
});

test('abonnement : le statut appliqué est celui relu chez Stripe, avec l\'heure de lecture', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  stripe.nowSeconds = torontoMidnight('2026-11-03');
  stripe.subscriptionStatus.set('sub_x', 'active');
  await syncSubscription({ eventId: 'evt_old', type: 'invoice.payment_failed', subscriptionId: 'sub_x' }, deps(repo, stripe));
  assert.equal(repo.states[0].status, 'active');
  assert.equal(repo.states[0].readAt, new Date(torontoMidnight('2026-11-03') * 1000).toISOString());
  assert.equal(repo.states[0].eventId, 'evt_old');
});

test('suivi du remboursement : seul un remboursement connu est mis à jour', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  await startCheckout(input(), deps(repo, stripe), '2026-10-20');
  repo.eligibility = 'refused'; stripe.nextRefundStatus = 'pending';
  await completeCheckout(input().attemptId, 'evt_p', deps(repo, stripe));
  const refundId = repo.attempts.get(input().attemptId)!.refundId!;
  assert.equal(await syncRefund({ refundId, status: 'failed' }, { repository: repo }), true);
  assert.equal(repo.refundStatus.get(refundId), 'failed');
  assert.equal(await syncRefund({ refundId: 're_inconnu', status: 'failed' }, { repository: repo }), false);
});
