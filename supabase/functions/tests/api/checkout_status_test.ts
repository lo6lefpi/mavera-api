import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicApi, type PublicApiDeps, STATUS_LIMITS } from '../../public-api/handler.ts';
import type { BillingGateway, CheckoutRepository } from '../../_shared/services/ports.ts';
import { STATUS_SESSION as SESSION, statusFixture, stripeState } from '../services/status-fixtures.ts';

const SITE = 'https://mavera.test';
function post(payload: unknown = { sessionId: SESSION }, origin: string | null = SITE, ip = '203.0.113.7') {
  return new Request('https://api.test/functions/v1/public-api/checkout-status', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip,
      ...(origin ? { origin } : {}) },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}
function setup() {
  const a = statusFixture();
  const state = stripeState(a);
  const reads: string[] = [];
  const hits = new Map<string, number>();
  // Toute tentative de mutation ou lecture de coordonnées échoue immédiatement.
  const readOnly = <T extends object>(target: T) => new Proxy(target, {
    get: (t, key) => {
      if (!(key in t)) throw new Error(`Appel non autorisé : ${String(key)}`);
      return Reflect.get(t, key);
    },
  });
  const repository = readOnly({ getStatusBySession: (id: string) => {
    reads.push('attempt'); return Promise.resolve(id === SESSION ? a : null);
  } }) as CheckoutRepository;
  const billing = readOnly({
    getCheckoutStatus: () => { reads.push('stripe'); return Promise.resolve(state); },
    getRefundStatus: () => { reads.push('refund'); return Promise.resolve('pending' as const); },
  }) as unknown as BillingGateway;
  const deps: PublicApiDeps = {
    allowedOrigins: [SITE],
    today: () => { throw new Error('Aucun recalcul'); },
    humanCheck: { verify: () => { throw new Error('Aucun CAPTCHA pour la consultation'); } },
    checkoutDeps: () => ({ repository, billing }),
    rateLimiter: () => ({ allow: (key, limit) => {
      const n = (hits.get(key) ?? 0) + 1; hits.set(key, n); return Promise.resolve(n <= limit);
    } }),
  };
  return { a, state, reads, hits, deps };
}

test('checkout-status : POST autorisé, CORS, no-store, aucune mutation ni donnée privée', async () => {
  const { a, deps, reads } = setup();
  Object.assign(a, { email: 'secret@exemple.ca', phone: '5145559999', displayName: 'Nom confidentiel',
    rejectionReason: 'inscription_refused', stripeCustomerId: 'cus_secret' });
  const before = structuredClone(a);
  const response = await handlePublicApi(post(), deps);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), SITE);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'verifying', summary: {
    planCode: 'depart', billingOption: 'monthly', currency: 'cad',
    paidTodayCents: 20466, pendingTodayCents: null, nextCharge: { amountCents: 9083, on: '2026-11-01' },
  } });
  assert.deepEqual(a, before);
  assert.deepEqual(reads, ['attempt', 'stripe']);
});

test('checkout-status : enveloppes exactes de confirmation, traitement et refus', async () => {
  for (const status of ['confirmed', 'processing', 'rejected'] as const) {
    const { a, deps, state } = setup();
    if (status === 'processing') {
      state.paymentStatus = 'unpaid'; state.paymentIntentStatus = 'processing';
    } else {
      a.paidAt = '2026-10-20T12:00:00Z'; a.paidAmountCents = a.quote.dueToday.totalCents;
      if (status === 'confirmed') { a.completedAt = a.paidAt; a.dossierExists = true; }
      else { a.rejectedAt = a.paidAt; a.refundId = 're_secret'; a.refundAmountCents = 20466; }
    }
    const response = await handlePublicApi(post(), deps);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), status === 'rejected'
      ? { status, refund: { status: 'pending', currency: 'cad', amountCents: 20466 } }
      : { status, summary: { planCode: 'depart', billingOption: 'monthly', currency: 'cad',
        paidTodayCents: status === 'processing' ? null : 20466,
        pendingTodayCents: status === 'processing' ? 20466 : null,
        nextCharge: { amountCents: 9083, on: '2026-11-01' } } });
  }
});

test('checkout-status : réponses neutres identiques, sans preuve de l’existence de la session', async () => {
  for (const kind of ['unknown', 'open', 'expired', 'failed', 'unpaid']) {
    const { deps, state } = setup();
    if (kind === 'open' || kind === 'expired') state.status = kind;
    if (kind === 'failed' || kind === 'unpaid') {
      state.paymentStatus = 'unpaid'; state.paymentIntentStatus = kind === 'failed' ? 'canceled' : 'requires_payment_method';
    }
    const response = await handlePublicApi(post({ sessionId: kind === 'unknown' ? 'cs_test_absent' : SESSION }), deps);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), '{"status":"unknown"}');
  }
});

test('checkout-status : validation avant accès au dossier et à Stripe', async () => {
  const { deps, reads } = setup();
  for (const payload of ['{invalid', null, [], {}, { sessionId: 42 }, { sessionId: 'cs_' },
    { sessionId: 'cs_test_a?email=secret' }, { sessionId: 'cs_test_a\n' }, { sessionId: 'cs_' + 'a'.repeat(253) }]) {
    const response = await handlePublicApi(post(payload), deps);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_request');
  }
  assert.deepEqual(reads, []);
});

test('checkout-status : origine obligatoire, méthode, OPTIONS et corps borné', async () => {
  const { deps, reads } = setup();
  for (const origin of [null, 'https://pirate.test']) {
    assert.equal((await handlePublicApi(post({}, origin), deps)).status, 403);
  }
  const url = post().url;
  assert.equal((await handlePublicApi(new Request(url), deps)).status, 405);
  const options = await handlePublicApi(new Request(url, { method: 'OPTIONS', headers: { origin: SITE } }), deps);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), SITE);
  const tooLarge = await handlePublicApi(post({ sessionId: 'cs_' + 'a'.repeat(17_000) }), deps);
  assert.equal(tooLarge.status, 413);
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(17_000)); c.close(); } });
  const streamed = new Request(url, { method: 'POST', headers: { origin: SITE }, body: stream, duplex: 'half' } as RequestInit);
  assert.equal((await handlePublicApi(streamed, deps)).status, 413);
  assert.deepEqual(reads, []);
});

test('checkout-status : limites IP avant lecture et couple IP/session, Retry-After', async () => {
  const { deps, reads } = setup();
  let last: Response | undefined;
  for (let i = 0; i <= STATUS_LIMITS.ip.limit; i++) last = await handlePublicApi(post('{invalid'), deps);
  assert.equal(last!.status, 429);
  assert.equal(last!.headers.get('retry-after'), '60');
  assert.equal(last!.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.deepEqual(reads, []);

  const fresh = setup();
  for (let i = 0; i < STATUS_LIMITS.session.limit; i++) {
    assert.equal((await handlePublicApi(post(), fresh.deps)).status, 200);
  }
  const limited = await handlePublicApi(post(), fresh.deps);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'too_many_requests');
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(limited.headers.get('access-control-expose-headers'), 'Retry-After');
  assert.equal((await handlePublicApi(post({}, SITE, '203.0.113.8'), fresh.deps)).status, 400);
  assert.equal((await handlePublicApi(post({ sessionId: SESSION }, SITE, '203.0.113.8'), fresh.deps)).status, 200);
  assert.equal((await handlePublicApi(post({ sessionId: 'cs_other' }), fresh.deps)).status, 200);
});

test('checkout-status : pannes génériques, aucun secret dans la réponse ni les logs', async () => {
  const logs: unknown[][] = [];
  const original = console.error; console.error = (...args) => { logs.push(args); };
  const fail = () => Promise.reject(new Error(`secret@exemple.ca re_private ${SESSION}`));
  try {
    for (const failure of ['db', 'stripe', 'refund', 'limiter']) {
      const { a, deps } = setup();
      const services = deps.checkoutDeps();
      if (failure === 'db') services.repository.getStatusBySession = fail;
      if (failure === 'stripe') services.billing.getCheckoutStatus = fail;
      if (failure === 'refund') {
        a.paidAt = a.rejectedAt = '2026-10-20T12:00:00Z'; a.refundId = 're_private';
        services.billing.getRefundStatus = fail;
      }
      if (failure === 'limiter') deps.rateLimiter = () => ({ allow: fail });
      const response = await handlePublicApi(post(), deps);
      assert.equal(response.status, 503, failure);
      assert.deepEqual(await response.json(), { error: { code: 'unavailable',
        message: 'Le service est momentanément indisponible. Réessayez dans quelques minutes.' } });
    }
    assert.ok(!JSON.stringify(logs).includes(SESSION));
    assert.ok(!JSON.stringify(logs).includes('secret@exemple.ca'));
    assert.ok(!JSON.stringify(logs).includes('re_private'));
  } finally { console.error = original; }
});
