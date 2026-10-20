import test from 'node:test';
import assert from 'node:assert/strict';
import type { CheckoutAttempt, CheckoutQuote, Eligibility, PaymentProof, SignupInput,
  StripeSubscriptionRecord, BillingFact, CheckoutRepository } from '../../_shared/services/ports.ts';
import { startCheckout, prepareQuote } from '../../_shared/services/start-checkout.ts';
import { completeCheckout } from '../../_shared/services/complete-checkout.ts';
import { FakeStripeGateway } from '../../_shared/integrations/stripe/fake-gateway.ts';
import { torontoMidnight } from '../../_shared/integrations/stripe/time.ts';

const input = (extra: Partial<SignupInput> = {}): SignupInput => ({
  attemptId: '7fc50a4e-ec4b-47e3-998a-3d5f99e55b91', email: 'Test@Example.ca', phone: '5145550100',
  displayName: 'Test Co', planCode: 'depart', billingOption: 'monthly',
  startMonth: 'current', booksUpToDate: true, usesQuickbooks: false,
  estimatedTransactions: 14, successUrl: 'https://example.ca/success', cancelUrl: 'https://example.ca/cancel', ...extra,
});
class FakeRepository implements CheckoutRepository {
  attempts = new Map<string, CheckoutAttempt>();
  eligibility: Eligibility = 'new';
  token: string | null = null;
  completeCalls = 0;
  failOnce = false;
  checkEligibility(): Promise<Eligibility> { return Promise.resolve(this.eligibility); }
  existingCustomerId(): Promise<string | null> { return Promise.resolve(null); }
  async createAttempt(i: SignupInput, quote: CheckoutQuote) {
    const attempt: CheckoutAttempt = { id: i.attemptId, createdAt: new Date().toISOString(),
      email: i.email, phone: i.phone, displayName: i.displayName,
      booksUpToDate: i.booksUpToDate, usesQuickbooks: i.usesQuickbooks,
      estimatedTransactions: i.estimatedTransactions, quote,
      stripeSessionId: null, stripeCustomerId: null, stripePaymentIntentId: null,
      stripeSubscriptionId: null, stripePriceId: null, stripeStatus: null,
      paidAt: null, completedAt: null, rejectedAt: null, refundId: null };
    this.attempts.set(i.attemptId, attempt); return attempt;
  }
  getAttempt(id: string) { return Promise.resolve(this.attempts.get(id) ?? null); }
  async saveSession(id: string, sessionId: string) { this.attempts.get(id)!.stripeSessionId = sessionId; }
  async claim(_id: string, token: string) { if (this.token) return false; this.token = token; return true; }
  async savePayment(id: string, _token: string, proof: PaymentProof) {
    const a = this.attempts.get(id)!;
    a.stripeCustomerId = proof.customerId; a.stripePaymentIntentId = proof.paymentIntentId; a.paidAt = new Date().toISOString();
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
  async reject(id: string, _token: string, refundId: string) {
    this.attempts.get(id)!.rejectedAt = new Date().toISOString();
    this.attempts.get(id)!.refundId = refundId;
  }
  async release() { this.token = null; }
  async recordFact(_fact: BillingFact) { return true; }
}

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
