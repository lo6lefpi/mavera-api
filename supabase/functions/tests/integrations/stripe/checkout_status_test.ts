import test from 'node:test';
import assert from 'node:assert/strict';
import { Stripe } from '../../../_shared/integrations/stripe/client.ts';
import { checkoutSuccessUrl, StripeGateway } from '../../../_shared/integrations/stripe/gateway.ts';

function setup(session: Record<string, unknown>, errorStatus = 200, intentStatus = 'succeeded') {
  const requests: { method: string; url: string }[] = [];
  const stripe = new Stripe('sk_test_local_only', {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient((input, init) => {
      const url = String(input);
      requests.push({ method: init?.method ?? 'GET', url });
      const body = url.includes('/payment_intents/')
        ? { id: 'pi_private', status: intentStatus } : session;
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: errorStatus, headers: { 'content-type': 'application/json' },
      }));
    }),
  });
  return { gateway: new StripeGateway(stripe), requests };
}
const SESSION = { id: 'cs_test_read', mode: 'payment', status: 'complete', payment_status: 'paid',
  metadata: { attempt_id: 'attempt_private' }, payment_intent: { id: 'pi_private', status: 'succeeded' },
  customer_email: 'secret@exemple.ca', customer: 'cus_private' };

test('Stripe : consultation par GET avec expansion du paiement, faits minimaux', async () => {
  const { gateway, requests } = setup(SESSION);
  assert.deepEqual(await gateway.getCheckoutStatus('cs_test_read'), {
    sessionId: 'cs_test_read', attemptId: 'attempt_private', mode: 'payment',
    status: 'complete', paymentStatus: 'paid', paymentIntentStatus: 'succeeded',
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/v1/checkout/sessions/cs_test_read');
  assert.equal(url.searchParams.get('expand[0]'), 'payment_intent');
});

test('Stripe : paiement asynchrone en traitement, session sans paiement et non développée', async () => {
  const processing = setup({ ...SESSION, payment_status: 'unpaid', payment_intent: { id: 'pi_private', status: 'processing' } });
  assert.equal((await processing.gateway.getCheckoutStatus('cs_test_read'))?.paymentIntentStatus, 'processing');
  const empty = setup({ ...SESSION, status: 'open', payment_status: 'unpaid', payment_intent: null, metadata: null });
  assert.equal((await empty.gateway.getCheckoutStatus('cs_test_read'))?.paymentIntentStatus, null);
  assert.equal(empty.requests.length, 1);
  const unexpanded = setup({ ...SESSION, payment_intent: 'pi_private' });
  assert.equal((await unexpanded.gateway.getCheckoutStatus('cs_test_read'))?.paymentIntentStatus, 'succeeded');
  assert.equal(unexpanded.requests.length, 2);
  assert.ok(unexpanded.requests.every(r => r.method === 'GET'));
});

test('Stripe : session inconnue neutre, autres erreurs remontées', async () => {
  const absent = setup({ error: { type: 'invalid_request_error', code: 'resource_missing', message: 'private id' } }, 404);
  assert.equal(await absent.gateway.getCheckoutStatus('cs_test_read'), null);
  const down = setup({ error: { type: 'api_error', message: 'private details' } }, 503);
  await assert.rejects(down.gateway.getCheckoutStatus('cs_test_read'));
  const auth = setup({ error: { type: 'invalid_request_error', message: 'invalid key' } }, 401);
  await assert.rejects(auth.gateway.getCheckoutStatus('cs_test_read'));
});

test('retour Stripe : session_id unique, marqueur littéral, paramètres et fragment conservés', () => {
  for (const value of [
    'https://mavera.test/merci',
    'https://mavera.test/merci?lang=fr#confirmation',
    'https://mavera.test/merci?lang=fr&session_id=ancienne&session_id=autre#confirmation',
    'https://mavera.test/merci?lang=fr&session_id=%7BCHECKOUT_SESSION_ID%7D#confirmation',
  ]) {
    const result = checkoutSuccessUrl(value);
    const before = new URL(value); const after = new URL(result);
    assert.equal(after.origin, before.origin);
    assert.equal(after.pathname, before.pathname);
    assert.equal(after.hash, before.hash);
    assert.equal(after.searchParams.get('lang'), before.searchParams.get('lang'));
    assert.deepEqual(after.searchParams.getAll('session_id'), ['{CHECKOUT_SESSION_ID}']);
    assert.ok(result.includes('session_id={CHECKOUT_SESSION_ID}'));
    assert.ok(!result.includes('%7BCHECKOUT_SESSION_ID%7D'));
    assert.equal(checkoutSuccessUrl(result), result);
  }
});

test('création Stripe : success_url contient le marqueur au bon endroit, cancel_url conservée', async () => {
  const posted: URLSearchParams[] = [];
  const stripe = new Stripe('sk_test_local_only', {
    maxNetworkRetries: 0,
    httpClient: Stripe.createFetchHttpClient((input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/tax_rates') {
        return Promise.resolve(new Response(JSON.stringify({ object: 'list', has_more: false, data: [
          { id: 'txr_gst', active: true, inclusive: false, percentage: 5, country: 'CA', state: 'QC',
            tax_type: 'gst', metadata: { tax_code: 'gst' } },
          { id: 'txr_qst', active: true, inclusive: false, percentage: 9.975, country: 'CA', state: 'QC',
            tax_type: 'qst', metadata: { tax_code: 'qst' } },
        ] }), { headers: { 'content-type': 'application/json' } }));
      }
      assert.equal(url.pathname, '/v1/checkout/sessions');
      assert.equal(init?.method, 'POST');
      posted.push(new URLSearchParams(String(init?.body)));
      return Promise.resolve(new Response(JSON.stringify({ id: 'cs_test_new', amount_total: 1150,
        url: 'https://checkout.stripe.test/session' }), { headers: { 'content-type': 'application/json' } }));
    }),
  });
  const gateway = new StripeGateway(stripe);
  await gateway.createCheckoutSession({
    attemptId: 'a', email: 'test@exemple.ca',
    lines: [{ label: 'Ouverture', amountCents: 1000, gstCents: 50, qstCents: 100 }],
    successUrl: 'https://mavera.test/merci?lang=fr#confirmation',
    cancelUrl: 'https://mavera.test/forfaits?lang=fr', payBefore: '2099-01-01',
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].get('success_url'),
    'https://mavera.test/merci?lang=fr&session_id={CHECKOUT_SESSION_ID}#confirmation');
  assert.equal(posted[0].get('cancel_url'), 'https://mavera.test/forfaits?lang=fr');
  // Simulation de la substitution Stripe : exactement le paramètre que le site lira.
  const returned = new URL(posted[0].get('success_url')!.replace('{CHECKOUT_SESSION_ID}', 'cs_test_new'));
  assert.equal(returned.searchParams.get('session_id'), 'cs_test_new');
});
