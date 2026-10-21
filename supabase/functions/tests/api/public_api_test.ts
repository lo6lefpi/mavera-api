import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicApi, LIMITS, montrealToday, type PublicApiDeps, type RateLimiter } from '../../public-api/handler.ts';
import { TurnstileVerifier } from '../../_shared/integrations/turnstile/verify.ts';
import { FakeStripeGateway } from '../../_shared/integrations/stripe/fake-gateway.ts';
import { torontoMidnight } from '../../_shared/integrations/stripe/time.ts';
import type { CheckoutRepository } from '../../_shared/services/ports.ts';
import { FakeRepository } from '../services/fake-repository.ts';

const SITE = 'https://mavera.test';
const body = (extra: Record<string, unknown> = {}) => ({
  attemptId: '7fc50a4e-ec4b-47e3-998a-3d5f99e55b91', email: 'Test@Example.ca', phone: '5145550100',
  displayName: 'Test Co', planCode: 'depart', billingOption: 'monthly', startMonth: 'current',
  booksUpToDate: true, usesQuickbooks: false, estimatedTransactions: 14,
  successUrl: `${SITE}/merci`, cancelUrl: `${SITE}/forfaits`, captchaToken: 'jeton-humain', ...extra,
});
const post = (route: string, payload: unknown, origin: string | null = SITE, ip = '203.0.113.7') =>
  new Request(`http://localhost/functions/v1/public-api/${route}`, {
    method: 'POST',
    headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json', 'x-forwarded-for': `${ip}, 10.0.0.1` },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

/** Même règle que rate_limit_hit, en mémoire. */
class MemoryLimiter implements RateLimiter {
  hits = new Map<string, number>();
  allow(key: string, limit: number) {
    const n = (this.hits.get(key) ?? 0) + 1; this.hits.set(key, n);
    return Promise.resolve(n <= limit);
  }
}
function setup(today = '2026-10-20') {
  const repo = new FakeRepository(); const stripe = new FakeStripeGateway(); const limiter = new MemoryLimiter();
  let built = 0;
  const deps: PublicApiDeps = {
    allowedOrigins: [SITE], today: () => today,
    humanCheck: { verify: (token: string) => Promise.resolve(token === 'jeton-humain') },
    rateLimiter: () => limiter,
    checkoutDeps: () => { built++; return { billing: stripe, repository: repo }; },
  };
  return { repo, stripe, deps, limiter, built: () => built };
}
async function error(res: Response) {
  return (await res.json() as { error: { code: string; message: string; details?: string[] } }).error;
}

test('checkout : adresse de paiement Stripe et récapitulatif, en-tête CORS du site', async () => {
  const { deps, stripe } = setup();
  const res = await handlePublicApi(post('checkout', body()), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  const data = await res.json();
  assert.match(data.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(data.quote.dueToday.totalCents, 20466);
  assert.equal(stripe.checkoutCreates, 1);
});

test('quote : récapitulatif sans Stripe ni base de données', async () => {
  const { deps, built } = setup();
  const res = await handlePublicApi(post('quote', { planCode: 'elan', billingOption: 'annual',
    startMonth: 'next', estimatedTransactions: 40 }), deps);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).quote.terms.planCode, 'elan');
  assert.equal(built(), 0);
});

test('demandes mal formées : 400 invalid_request, jamais une panne', async () => {
  const { deps, stripe } = setup();
  for (const payload of [
    '{pas du json', [], body({ email: 'pas-un-courriel' }), body({ booksUpToDate: 'oui' }),
    body({ estimatedTransactions: -1 }), body({ billingOption: 'weekly' }), body({ attemptId: 'abc' }),
    body({ planCode: 'inconnu' }), body({ planCode: 'trajet' }),
  ]) {
    const res = await handlePublicApi(post('checkout', payload), deps);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.equal((await error(res)).code, 'invalid_request');
  }
  assert.equal(stripe.checkoutCreates, 0);
});

test('adresse de retour vers un autre site : refusée', async () => {
  const { deps } = setup();
  const res = await handlePublicApi(post('checkout', body({ successUrl: 'https://pirate.test/merci' })), deps);
  assert.equal(res.status, 400);
});

test('origine inconnue, mauvaise méthode, route inconnue, corps trop gros', async () => {
  const { deps } = setup();
  assert.equal((await handlePublicApi(post('checkout', body(), 'https://pirate.test'), deps)).status, 403);
  assert.equal((await handlePublicApi(new Request('http://localhost/public-api/checkout'), deps)).status, 405);
  assert.equal((await handlePublicApi(post('admin', body()), deps)).status, 404);
  assert.equal((await handlePublicApi(post('checkout', body({ displayName: 'x'.repeat(20_000) })), deps)).status, 413);
  const preflight = await handlePublicApi(new Request('http://localhost/public-api/checkout',
    { method: 'OPTIONS', headers: { origin: SITE } }), deps);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), SITE);
});

test('Trajet non admissible : 422 avec les critères non remplis', async () => {
  const { deps } = setup();
  const res = await handlePublicApi(post('checkout', body({ planCode: 'trajet', estimatedTransactions: 14,
    trajetProfile: { platformIncomeOnly: false, issuesClientInvoices: false, accounts: 1, monthlyTransactions: 14 } })), deps);
  assert.equal(res.status, 422);
  const e = await error(res);
  assert.equal(e.code, 'trajet_not_eligible');
  assert.ok(e.details && e.details.length > 0);
});

test('ancien client ou refus : même réponse, le site ne révèle pas qui est client', async () => {
  for (const [eligibility, code, status] of [
    ['returning', 'cannot_signup_online', 409], ['active', 'cannot_signup_online', 409],
    ['refused', 'cannot_signup_online', 409],
  ] as const) {
    const { deps, repo } = setup(); repo.eligibility = eligibility;
    const res = await handlePublicApi(post('checkout', body()), deps);
    assert.equal(res.status, status);
    const e = await error(res);
    assert.equal(e.code, code);
    assert.ok(e.message.length > 20);
  }
});

test('paiement déjà en cours pour ce courriel : 409 payment_in_progress', async () => {
  const { deps, repo } = setup();
  await handlePublicApi(post('checkout', body()), deps);
  repo.attempts.get(body().attemptId as string)!.paidAt = new Date().toISOString();
  const res = await handlePublicApi(post('checkout', body({ attemptId: '0b6d9f0e-3c1a-4f7e-9a51-6c2d8e4f1a20' })), deps);
  assert.equal(res.status, 409);
  assert.equal((await error(res)).code, 'payment_in_progress');
});

test('page de paiement expirée : 410, le site recommence avec un nouvel identifiant', async () => {
  const { deps, stripe } = setup();
  const first = await (await handlePublicApi(post('checkout', body()), deps)).json();
  stripe.sessionStatus.set(new URL(first.url).pathname.slice(1), 'expired');
  const res = await handlePublicApi(post('checkout', body()), deps);
  assert.equal(res.status, 410);
  assert.equal((await error(res)).code, 'attempt_expired');
});

test('dernière demi-heure du mois : 409 checkout_window_closed', async () => {
  const { deps, stripe } = setup('2026-10-31');
  stripe.nowSeconds = torontoMidnight('2026-11-01') - 20 * 60;
  const res = await handlePublicApi(post('checkout', body()), deps);
  assert.equal(res.status, 409);
  assert.equal((await error(res)).code, 'checkout_window_closed');
});

test('panne (base ou Stripe) : 503 sans détail technique', async () => {
  const { deps, repo } = setup();
  const broken: CheckoutRepository = Object.assign(Object.create(repo), {
    checkEligibility: () => Promise.reject(new Error('connexion refusée : 10.0.0.5:5432')),
  });
  const original = console.error; console.error = () => {};
  try {
    const res = await handlePublicApi(post('checkout', body()),
      { ...deps, checkoutDeps: () => ({ billing: new FakeStripeGateway(), repository: broken }) });
    assert.equal(res.status, 503);
    const e = await error(res);
    assert.equal(e.code, 'unavailable');
    assert.ok(!e.message.includes('10.0.0.5'));
  } finally { console.error = original; }
});

test('jour courant calculé à Montréal, pas en UTC', () => {
  assert.equal(montrealToday(new Date('2026-11-01T02:30:00Z')), '2026-10-31');
});

test('/checkout sans en-tête Origin : refusé (appel hors navigateur)', async () => {
  const { deps, stripe } = setup();
  assert.equal((await handlePublicApi(post('checkout', body(), null), deps)).status, 403);
  assert.equal((await handlePublicApi(post('quote', { planCode: 'depart', billingOption: 'monthly',
    startMonth: 'next', estimatedTransactions: 10 }, null), deps)).status, 200);
  assert.equal(stripe.checkoutCreates, 0);
});

test('vérification antirobot absente ou invalide : 403, aucune session Stripe', async () => {
  const { deps, stripe } = setup();
  for (const token of [undefined, 'faux']) {
    const res = await handlePublicApi(post('checkout', body({ captchaToken: token })), deps);
    assert.equal(res.status, 403);
    assert.equal((await error(res)).code, 'human_check_failed');
  }
  assert.equal(stripe.checkoutCreates, 0);
});

test('trop d\'appels : 429 par adresse IP, puis par courriel', async () => {
  const { deps } = setup();
  let last: Response | undefined;
  for (let i = 0; i <= LIMITS.ip.limit; i++) last = await handlePublicApi(post('checkout', '{pas du json'), deps);
  assert.equal(last!.status, 429);
  assert.equal(last!.headers.get('retry-after'), String(LIMITS.ip.windowSeconds));

  const fresh = setup();
  for (let i = 0; i < LIMITS.email.limit; i++) {
    await handlePublicApi(post('checkout', body(), SITE, `198.51.100.${i}`), fresh.deps);
  }
  const res = await handlePublicApi(post('checkout', body(), SITE, '198.51.100.99'), fresh.deps);
  assert.equal(res.status, 429);
  assert.equal((await error(res)).code, 'too_many_requests');
});

test('même identifiant avec d\'autres choix : 409 attempt_conflict', async () => {
  const { deps } = setup();
  await handlePublicApi(post('checkout', body({ startMonth: 'next' })), deps);
  const res = await handlePublicApi(post('checkout', body({ startMonth: 'current' })), deps);
  assert.equal(res.status, 409);
  assert.equal((await error(res)).code, 'attempt_conflict');
});

test('corps trop gros sans longueur annoncée : coupé à la lecture', async () => {
  const { deps } = setup();
  const big = new TextEncoder().encode(JSON.stringify(body({ displayName: 'x'.repeat(40_000) })));
  const stream = new ReadableStream({ start(c) { c.enqueue(big.slice(0, 20_000)); c.enqueue(big.slice(20_000)); c.close(); } });
  const res = await handlePublicApi(new Request('http://localhost/public-api/checkout', {
    method: 'POST', headers: { origin: SITE }, body: stream,
  }), deps);
  assert.equal(res.status, 413);
});

test('Turnstile : succès, échec et domaine inattendu', async () => {
  const reply = (outcome: unknown) => (() => Promise.resolve(new Response(JSON.stringify(outcome)))) as typeof fetch;
  assert.equal(await new TurnstileVerifier('s', ['mavera.test'], reply({ success: true, hostname: 'mavera.test' })).verify('t', null), true);
  assert.equal(await new TurnstileVerifier('s', ['mavera.test'], reply({ success: false })).verify('t', null), false);
  assert.equal(await new TurnstileVerifier('s', ['mavera.test'], reply({ success: true, hostname: 'pirate.test' })).verify('t', null), false);
  assert.equal(await new TurnstileVerifier('s', [], reply({ success: true })).verify('', null), false);
  // Clé de test Cloudflare : faux domaine accepté; jamais avec une vraie clé.
  const testKey = '1x0000000000000000000000000000000AA';
  assert.equal(await new TurnstileVerifier(testKey, ['localhost'], reply({ success: true, hostname: 'example.com' })).verify('t', null), true);
  assert.equal(await new TurnstileVerifier(testKey, ['localhost'], reply({ success: false })).verify('t', null), false);
});
