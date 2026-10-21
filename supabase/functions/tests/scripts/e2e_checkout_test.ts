import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArtifactsFoundError, assertAcceptedRefund, type BankState, createBankCheckout, type E2EContext, e2eFetch, observeBankOutcome,
} from '../../../../scripts/e2e-checkout-scenarios.ts';
import { Stripe } from '../../_shared/integrations/stripe/client.ts';
import { quoteCheckout } from '../../_shared/domain/pricing/mod.ts';
import type { SignupInput } from '../../_shared/services/ports.ts';

const waiting: BankState = { status: null, method: null, failed: false };
const pending: BankState = { status: 'processing', method: 'acss_debit', failed: false };
const paid: BankState = { ...pending, status: 'succeeded' };
const declined: BankState = { ...pending, status: 'requires_payment_method', failed: true };
function observations(sequence: BankState[]) {
  let i = 0; let absent = 0; let completed = 0;
  return {
    io: {
      read: () => Promise.resolve(sequence[Math.min(i++, sequence.length - 1)]),
      noArtifacts: () => { absent++; return Promise.resolve(); },
      completedWhilePending: () => { completed++; return Promise.resolve(); },
      pause: () => Promise.resolve(),
    },
    counts: () => ({ absent, completed }),
  };
}

test('E2E ACSS : attente réelle sans création, puis confirmation', async () => {
  const { io, counts } = observations([waiting, pending, pending, pending, pending, paid]);
  await observeBankOutcome('success', io, 10);
  assert.deepEqual(counts(), { absent: 2, completed: 1 });
});

test('E2E ACSS : refus bancaire après attente, aucune création au résultat final', async () => {
  const { io, counts } = observations([waiting, pending, pending, declined]);
  await observeBankOutcome('failure', io, 10);
  assert.deepEqual(counts(), { absent: 2, completed: 1 });
});

test('E2E ACSS : création prématurée ou erreur de lecture font échouer le test', async () => {
  const early = observations([pending]);
  early.io.noArtifacts = () => Promise.reject(new ArtifactsFoundError('dossier trop tôt'));
  await assert.rejects(observeBankOutcome('success', early.io, 3), /dossier trop tôt/);
  const brokenDb = observations([pending, paid]);
  brokenDb.io.noArtifacts = () => Promise.reject(new Error('base inaccessible'));
  await assert.rejects(observeBankOutcome('success', brokenDb.io, 3), /base inaccessible/);
});

test('E2E ACSS : une carte, un succès immédiat ou un résultat opposé ne valident pas le parcours', async () => {
  await assert.rejects(observeBankOutcome('success', observations([{ ...paid, method: 'card' }]).io, 3), /pas une carte/);
  await assert.rejects(observeBankOutcome('success', observations([paid]).io, 3), /Attente bancaire non observée/);
  await assert.rejects(observeBankOutcome('failure', observations([pending, pending, paid]).io, 3), /différent/);
  await assert.rejects(observeBankOutcome('success', observations([pending, pending, declined]).io, 3), /différent/);
});

test('E2E ACSS : le dépassement du délai fait échouer le test', async () => {
  await assert.rejects(observeBankOutcome('success', observations([waiting]).io, 3), /Aucun résultat bancaire/);
  await assert.rejects(observeBankOutcome('success', observations([pending]).io, 3), /Aucun résultat bancaire/);
});

test('E2E refus : seul un remboursement complet accepté permet de valider', () => {
  const a = { paid_at: '2026-10-21T12:00:00Z', rejected_at: '2026-10-21T12:01:00Z',
    paid_amount_cents: 20466, refund_amount_cents: 20466, refund_id: 're_test', refund_status: 'pending' };
  for (const status of ['pending', 'succeeded']) {
    assert.doesNotThrow(() => assertAcceptedRefund({ ...a, refund_status: status }, 20466, { status, amount: 20466 }));
  }
  for (const status of ['failed', 'canceled', 'requires_action', null]) {
    assert.throws(() => assertAcceptedRefund(a, 20466, { status, amount: 20466 }), /remboursement complet/);
  }
  for (const partial of [
    { refund_amount_cents: 100 }, { paid_amount_cents: 100 }, { refund_id: null },
    { refund_status: 'failed' }, { rejected_at: null }, { paid_at: null }, { completed_at: '2026-10-21T12:01:00Z' },
  ]) {
    assert.throws(() => assertAcceptedRefund({ ...a, ...partial }, 20466, { status: 'succeeded', amount: 20466 }), /remboursement complet/);
  }
  assert.throws(() => assertAcceptedRefund(a, 20466, { status: 'succeeded', amount: 100 }), /remboursement complet/);
});

test('E2E réseau : délai borné et annulation si les en-têtes ou le corps restent bloqués', async () => {
  const originalFetch = globalThis.fetch;
  let aborted = false;
  try {
    globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(new DOMException('Abort', 'AbortError')); }, { once: true });
    });
    await assert.rejects(e2eFetch('http://localhost:54321', undefined, 10), /Aucune réponse complète/);
    assert.equal(aborted, true);
    aborted = false;
    globalThis.fetch = (_input, init) => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener('abort', () => {
          aborted = true; controller.error(new DOMException('Abort', 'AbortError'));
        }, { once: true });
      },
    })));
    await assert.rejects(e2eFetch('http://localhost:54321', undefined, 10), /Aucune réponse complète/);
    assert.equal(aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('E2E réseau : statut, en-têtes et corps d’erreur préservés', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response('{"error":"indisponible"}', {
    status: 503, headers: { 'content-type': 'application/json', 'retry-after': '60' },
  }));
  try {
    const response = await e2eFetch('http://localhost:54321');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.deepEqual(await response.json(), { error: 'indisponible' });
  } finally { globalThis.fetch = originalFetch; }
});

test('E2E diagnostic : une erreur précise l’étape interrompue avant tout appel Stripe ou SQL', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response('{"error":{"code":"origin_refused"}}', { status: 403 }));
  const forbidden = new Proxy({}, { get: () => { throw new Error('Stripe/SQL ne doit pas être appelé'); } });
  try {
    await assert.rejects(createBankCheckout({ db: forbidden, stripe: forbidden,
      url: 'http://localhost:54321', site: 'https://mavera.test', webhookSecret: '', startedAt: 0 } as E2EContext,
      {} as SignupInput), /Lecture du récapitulatif auprès de public-api \/quote : HTTP 403/);
  } finally { globalThis.fetch = originalFetch; }
});

test('E2E ACSS : montage réel des requêtes Stripe et tentative liée au récapitulatif enregistré', async () => {
  const input: SignupInput = { attemptId: '7fc50a4e-ec4b-47e3-998a-3d5f99e55b91', email: 'e2e+acss@example.com',
    phone: '5145550199', displayName: 'Test', planCode: 'depart', billingOption: 'monthly', startMonth: 'current',
    booksUpToDate: true, usesQuickbooks: false, estimatedTransactions: 12,
    successUrl: 'https://mavera.test/merci', cancelUrl: 'https://mavera.test/forfaits' };
  const quote = quoteCheckout({ ...input, today: '2026-10-21' });
  const calls: { name: string; body?: Record<string, unknown> | URLSearchParams }[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const stripe = new Stripe('sk_test_local_only', { maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient((request, init) => {
      const path = new URL(String(request)).pathname;
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.push({ name: `${init?.method ?? 'GET'} ${path}`, body });
      if (path === '/v1/tax_rates') return Promise.resolve(json({ object: 'list', has_more: false, data: [
        { id: 'txr_gst', active: true, inclusive: false, percentage: 5, country: 'CA', state: 'QC',
          tax_type: 'gst', metadata: { tax_code: 'gst' } },
        { id: 'txr_qst', active: true, inclusive: false, percentage: 9.975, country: 'CA', state: 'QC',
          tax_type: 'qst', metadata: { tax_code: 'qst' } },
      ] }));
      assert.equal(path, '/v1/checkout/sessions');
      // Contrat Stripe vérifié en sandbox : ces deux paramètres étaient la cause du refus.
      assert.equal(body.get('payment_method_configuration'), null);
      assert.equal(body.get('payment_method_options[acss_debit][currency]'), null);
      assert.equal(body.get('payment_method_types[0]'), 'acss_debit');
      return Promise.resolve(json({ id: 'cs_test_bank', url: 'https://checkout.stripe.test/bank',
        payment_method_types: ['acss_debit'], amount_total: quote.dueToday.totalCents, livemode: false }));
    }),
  });
  const db = { rpc: (name: string, body: Record<string, unknown>) => {
    calls.push({ name, body });
    return Promise.resolve({ error: null, data: name === 'checkout_attempt_get' ? [{
      id: input.attemptId, email: input.email, granted_quote: quote,
    }] : null });
  } } as unknown as E2EContext['db'];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (request, init) => {
    assert.equal(String(request), 'http://localhost:54321/functions/v1/public-api/quote');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('origin'), 'https://mavera.test');
    return Promise.resolve(json({ quote }));
  };
  try {
    const result = await createBankCheckout({ db, stripe, url: 'http://localhost:54321', site: 'https://mavera.test',
      webhookSecret: 'whsec_test', startedAt: 0 }, input);
    assert.deepEqual(result, { url: 'https://checkout.stripe.test/bank', quote });
    const saved = calls.find(c => c.name === 'checkout_attempt_create')!.body as Record<string, unknown>;
    assert.deepEqual(saved.p_quote, quote);
    assert.match(String(saved.p_request_fingerprint), /^[a-f0-9]{64}$/);
    const session = calls.find(c => c.name === 'POST /v1/checkout/sessions')!.body as URLSearchParams;
    assert.equal(session.get('metadata[attempt_id]'), input.attemptId);
    assert.equal(session.get('payment_method_configuration'), null);
    assert.equal(session.get('payment_method_types[0]'), 'acss_debit');
    assert.equal(session.get('payment_method_types[1]'), null);
    assert.equal(session.get('payment_method_options[acss_debit][currency]'), null);
    assert.equal(session.get('currency'), 'cad');
    assert.equal(session.get('payment_method_options[acss_debit][verification_method]'), 'microdeposits');
    assert.equal(session.get('payment_intent_data[setup_future_usage]'), 'off_session');
    assert.equal(session.get('line_items[0][price_data][unit_amount]'), String(quote.dueToday.lines[0].amountCents));
    assert.equal(session.get('line_items[0][tax_rates][0]'), 'txr_gst');
    assert.equal(session.get('line_items[0][tax_rates][1]'), 'txr_qst');
    assert.equal(session.get('success_url'), 'https://mavera.test/merci?session_id={CHECKOUT_SESSION_ID}');
    assert.deepEqual(calls.at(-1), { name: 'checkout_attempt_save_session', body: {
      p_id: input.attemptId, p_session_id: 'cs_test_bank',
    } });
    assert.ok(!calls.some(c => /checkout_attempt_(finish|reject|paid|subscription)/.test(c.name)));
  } finally { globalThis.fetch = originalFetch; }
});
