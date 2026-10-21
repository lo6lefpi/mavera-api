import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutStatus, parseCheckoutSessionId } from '../../_shared/services/checkout-status.ts';
import type { CheckoutSessionState, RefundStatus } from '../../_shared/services/ports.ts';
import { STATUS_SESSION as SESSION, statusFixture, stripeState } from './status-fixtures.ts';

function setup() {
  const a = statusFixture();
  let state: CheckoutSessionState | null = stripeState(a);
  let refundStatus: RefundStatus = 'succeeded';
  const reads: string[] = [];
  const deps = {
    repository: { getStatusBySession: (id: string) => {
      reads.push('attempt'); return Promise.resolve(id === a.stripeSessionId ? a : null);
    } },
    billing: {
      getCheckoutStatus: () => { reads.push('stripe'); return Promise.resolve(state); },
      getRefundStatus: () => { reads.push('refund'); return Promise.resolve(refundStatus); },
    },
  };
  return { a, deps, reads, setState: (s: CheckoutSessionState | null) => { state = s; },
    setRefund: (s: RefundStatus) => { refundStatus = s; } };
}

for (const plan of ['trajet', 'depart', 'elan', 'envol']) {
  test(`consultation : forfait ${plan}, montants enregistrés taxes comprises`, async () => {
    const { a, deps } = setup();
    a.quote = statusFixture(plan).quote;
    a.paidAt = '2026-10-20T12:00:00Z'; a.completedAt = a.paidAt; a.dossierExists = true;
    a.paidAmountCents = a.quote.dueToday.totalCents;
    const result = await checkoutStatus(SESSION, deps);
    assert.deepEqual(result, {
      status: 'confirmed',
      summary: { planCode: plan, billingOption: 'monthly', currency: 'cad',
        paidTodayCents: a.quote.dueToday.totalCents, pendingTodayCents: null,
        nextCharge: { amountCents: a.quote.recurring.totalCents, on: '2026-11-01' } },
    });
    assert.ok(a.quote.recurring.totalCents > a.quote.recurring.amountCents);
  });
}

test('paiement bancaire en traitement : montant en attente seulement, aucun dossier', async () => {
  const { a, deps, setState } = setup();
  setState({ ...stripeState(a), paymentStatus: 'unpaid', paymentIntentStatus: 'processing' });
  const result = await checkoutStatus(SESSION, deps);
  assert.equal(result.status, 'processing');
  assert.ok('summary' in result);
  assert.equal(result.summary.paidTodayCents, null);
  assert.equal(result.summary.pendingTodayCents, a.quote.dueToday.totalCents);
});

test('payé avant le webhook ou avec finalisation partielle : vérification, jamais confirmé', async () => {
  for (const stage of ['before_webhook', 'payment_saved', 'subscription_created', 'missing_dossier', 'missing_completion', 'wrong_amount']) {
    const { a, deps } = setup();
    if (stage !== 'before_webhook') {
      a.paidAt = '2026-10-20T12:00:00Z'; a.paidAmountCents = a.quote.dueToday.totalCents;
    }
    if (stage === 'missing_dossier' || stage === 'wrong_amount') a.completedAt = a.paidAt;
    if (stage === 'missing_completion' || stage === 'wrong_amount') a.dossierExists = true;
    if (stage === 'wrong_amount') a.paidAmountCents = 1;
    const result = await checkoutStatus(SESSION, deps);
    assert.equal(result.status, 'verifying', stage);
    assert.ok('summary' in result);
    assert.equal(result.summary.paidTodayCents, a.quote.dueToday.totalCents);
    assert.equal(result.summary.pendingTodayCents, null);
  }
});

for (const refund of ['succeeded', 'pending', 'failed', 'canceled', 'requires_action'] as const) {
  test(`refus : remboursement relu ${refund}, aucun message ni prochain prélèvement`, async () => {
    const { a, deps, setRefund, reads } = setup();
    a.paidAt = a.rejectedAt = '2026-10-20T12:00:00Z';
    a.refundId = 're_private'; a.refundAmountCents = 20466;
    setRefund(refund);
    const result = await checkoutStatus(SESSION, deps);
    assert.deepEqual(result, {
      status: 'rejected', refund: ['succeeded', 'pending'].includes(refund)
        ? { status: refund, currency: 'cad', amountCents: 20466 } : { status: 'contact_required' },
    });
    assert.deepEqual(reads, ['attempt', 'refund']);
  });
}

test('neutre : session absente, ouverte, expirée, non payée, échouée ou étrangère', async () => {
  const { a, deps, setState, reads } = setup();
  assert.deepEqual(await checkoutStatus('cs_test_unknown', deps), { status: 'unknown' });
  assert.deepEqual(reads, ['attempt']); // Aucune recherche Stripe pour une tentative inconnue.
  const base = stripeState(a);
  for (const state of [null,
    { ...base, status: 'open' }, { ...base, status: 'expired' },
    ...['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'canceled', null]
      .map(paymentIntentStatus => ({ ...base, paymentStatus: 'unpaid', paymentIntentStatus })),
    { ...base, paymentStatus: 'no_payment_required' },
    { ...base, attemptId: 'other' }, { ...base, sessionId: 'cs_other' }, { ...base, mode: 'subscription' },
    { ...base, paymentStatus: 'unpaid', paymentIntentStatus: 'succeeded' },
  ]) {
    setState(state);
    assert.deepEqual(await checkoutStatus(SESSION, deps), { status: 'unknown' }, JSON.stringify(state));
  }
});

test('montants et date accordés conservés, aucune référence à la grille courante', async () => {
  const { a, deps } = setup();
  a.quote = { ...a.quote,
    terms: { ...a.quote.terms, billingOption: 'annual', gridVersion: 'ancienne', recurringPriceCents: 12300 },
    dueToday: { ...a.quote.dueToday, totalCents: 45678 },
    recurring: { ...a.quote.recurring, cycle: 'year', totalCents: 14142, nextChargeOn: '2027-01-01' },
  };
  const result = await checkoutStatus(SESSION, deps);
  assert.ok('summary' in result);
  assert.equal(result.summary.billingOption, 'annual');
  assert.equal(result.summary.paidTodayCents, 45678);
  assert.deepEqual(result.summary.nextCharge, { amountCents: 14142, on: '2027-01-01' });
});

test('lecture seule et confidentialité : même avec des champs privés supplémentaires', async () => {
  const { a, deps } = setup();
  Object.assign(a, { email: 'secret@example.ca', phone: '5145559999', displayName: 'Nom privé',
    rejectionReason: 'motif privé', stripeCustomerId: 'cus_secret' });
  const before = structuredClone(a);
  const result = await checkoutStatus(SESSION, deps); // Ces ports ne proposent aucune mutation.
  assert.deepEqual(a, before);
  const json = JSON.stringify(result);
  for (const value of [a.id, SESSION, 'secret@example.ca', '5145559999', 'Nom privé', 'motif privé', 'cus_secret', 'stripeRecurringLookupKey', 'message']) {
    assert.ok(!json.includes(value), value);
  }
});

test('identifiants mal formés refusés avant toute lecture', async () => {
  const { deps, reads } = setup();
  for (const value of [undefined, null, 123, '', 'cs_', 'pi_test', 'cs_test_a/b', ' cs_test_a', 'cs_' + 'a'.repeat(253)]) {
    assert.throws(() => parseCheckoutSessionId(value));
  }
  assert.equal(parseCheckoutSessionId('cs_' + 'a'.repeat(252)).length, 255);
  await assert.rejects(checkoutStatus('invalid', deps));
  assert.deepEqual(reads, []);
});
