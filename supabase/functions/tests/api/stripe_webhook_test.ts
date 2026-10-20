import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStripeWebhook } from '../../stripe-webhook/handler.ts';
import { Stripe } from '../../_shared/integrations/stripe/client.ts';
import { FakeStripeGateway } from '../../_shared/integrations/stripe/fake-gateway.ts';
import { startCheckout } from '../../_shared/services/start-checkout.ts';
import type { SignupInput } from '../../_shared/services/ports.ts';
import { FakeRepository } from '../services/fake-repository.ts';

const secret = 'whsec_local_test_signature_only';
Deno.env.set('STRIPE_WEBHOOK_SECRET', secret);
const ATTEMPT = '7fc50a4e-ec4b-47e3-998a-3d5f99e55b91';
const sign = (payload: string) =>
  new Stripe('sk_test_unused', { httpClient: Stripe.createFetchHttpClient() })
    .webhooks.generateTestHeaderStringAsync({ payload, secret, cryptoProvider: Stripe.createSubtleCryptoProvider() });
const event = (id: string, type: string, object: Record<string, unknown>) =>
  JSON.stringify({ id, object: 'event', type, created: 1792540000, data: { object } });
const deliver = async (payload: string, deps: Parameters<typeof handleStripeWebhook>[1], signature?: string) =>
  await handleStripeWebhook(new Request('http://localhost/functions/v1/stripe-webhook', {
    method: 'POST', headers: { 'stripe-signature': signature ?? await sign(payload) }, body: payload,
  }), deps);
const input: SignupInput = {
  attemptId: ATTEMPT, email: 'test@example.ca', phone: '5145550100', displayName: 'Test Co',
  planCode: 'depart', billingOption: 'monthly', startMonth: 'current', booksUpToDate: true,
  usesQuickbooks: false, estimatedTransactions: 14,
  successUrl: 'https://mavera.test/merci', cancelUrl: 'https://mavera.test/forfaits',
};
async function paidSignup() {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway();
  await startCheckout(input, { repository: repo, billing: stripe }, '2026-10-20');
  return { repo, stripe, deps: { services: () => ({ repository: repo, billing: stripe }) } };
}
const completed = event('evt_1', 'checkout.session.completed',
  { id: `cs_test_${ATTEMPT}`, object: 'checkout.session', metadata: { attempt_id: ATTEMPT } });
const quiet = async <T>(fn: () => Promise<T>) => {
  const original = console.error; console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

test('signature absente ou falsifiée : 400, aucun traitement', async () => {
  const { deps, repo } = await paidSignup();
  assert.equal((await deliver(completed, deps, 't=1,v1=faux')).status, 400);
  assert.equal(repo.completeCalls, 0);
});

test('paiement terminé : dossier créé une seule fois, même si Stripe renvoie l\'événement', async () => {
  const { deps, repo, stripe } = await paidSignup();
  const first = await deliver(completed, deps);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'completed');
  assert.equal(await (await deliver(completed, deps)).text(), 'already_completed');
  assert.equal(repo.completeCalls, 1);
  assert.equal(stripe.subscriptionCreates, 1);
});

test('traitement déjà en cours : 503 pour que Stripe renvoie plus tard', async () => {
  const { deps, repo } = await paidSignup();
  repo.token = 'autre-traitement';
  assert.equal((await deliver(completed, deps)).status, 503);
});

test('remboursement refusé par Stripe : 500, l\'événement sera rejoué', async () => {
  const { deps, repo, stripe } = await paidSignup();
  repo.eligibility = 'refused'; stripe.nextRefundStatus = 'failed';
  assert.equal((await quiet(() => deliver(completed, deps))).status, 500);
  assert.equal(repo.attempts.get(ATTEMPT)!.rejectedAt, null);
  stripe.nextRefundStatus = 'succeeded';
  assert.equal(await (await deliver(completed, deps)).text(), 'rejected');
});

test('facture : statut relu chez Stripe; abonnement inconnu → 500 et reprise', async () => {
  const { deps, repo, stripe } = await paidSignup();
  stripe.subscriptionStatus.set('sub_1', 'past_due');
  const invoice = event('evt_inv', 'invoice.payment_failed', { id: 'in_1', object: 'invoice',
    parent: { subscription_details: { subscription: 'sub_1', metadata: { attempt_id: ATTEMPT } } } });
  assert.equal((await deliver(invoice, deps)).status, 200);
  assert.equal(repo.states[0].status, 'past_due');
  repo.applySubscriptionState = () => Promise.reject(new Error('P0001 abonnement pas encore associé'));
  assert.equal((await quiet(() => deliver(invoice, deps))).status, 500);
});

test('remboursement : relu chez Stripe; pas encore enregistré → 500; inconnu ou étranger → 200', async () => {
  const { deps, stripe } = await paidSignup();
  const early = await stripe.refund({ attemptId: ATTEMPT, paymentIntentId: 'pi', amountCents: 17800, reason: 'x' });
  const ours = event('evt_ref', 'refund.updated',
    { id: early.refundId, object: 'refund', status: 'succeeded', metadata: { attempt_id: ATTEMPT } });
  assert.equal((await quiet(() => deliver(ours, deps))).status, 500);
  const unknown = event('evt_ref2', 'refund.failed',
    { id: early.refundId, object: 'refund', status: 'failed', metadata: { attempt_id: '0b6d9f0e-3c1a-4f7e-9a51-6c2d8e4f1a20' } });
  assert.equal(await (await deliver(unknown, deps)).text(), 'unknown_attempt');
  const other = event('evt_other', 'customer.created', { id: 'cus_1', object: 'customer' });
  assert.equal(await (await deliver(other, deps)).text(), 'ignoré');
});

test('session expirée chez Stripe : la tentative non payée est abandonnée', async () => {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway(); stripe.nextPaid = false;
  await startCheckout(input, { repository: repo, billing: stripe }, '2026-10-20');
  const deps = { services: () => ({ repository: repo, billing: stripe }) };
  const expired = event('evt_exp', 'checkout.session.expired',
    { id: `cs_test_${ATTEMPT}`, object: 'checkout.session', metadata: { attempt_id: ATTEMPT } });
  assert.equal(await (await deliver(expired, deps)).text(), 'abandoned');
  assert.ok(repo.attempts.get(ATTEMPT)!.abandonedAt);
});
