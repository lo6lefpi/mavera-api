import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseError, mapAttempt, type RpcClient, SupabaseCheckoutRepository, SupabaseRateLimiter }
  from '../../../_shared/integrations/supabase/repository.ts';
import { SignupError, type SignupInput } from '../../../_shared/services/ports.ts';

type Call = { fn: string; params: Record<string, unknown> };
function fakeDb(reply: (call: Call) => { data?: unknown; error?: { code: string; message: string } }) {
  const calls: Call[] = [];
  const db = {
    rpc: (fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      const r = reply({ fn, params });
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    },
  } as unknown as RpcClient;
  return { db, calls };
}
const input = { attemptId: 'a', email: 'x@y.ca', phone: '1', displayName: 'X', booksUpToDate: true,
  usesQuickbooks: false, estimatedTransactions: 3 } as SignupInput;

test('refus de checkout_attempt_create traduits pour le site', async () => {
  for (const [sqlstate, code] of [['P0004', 'not_allowed'], ['P0005', 'payment_in_progress'],
    ['P0006', 'returning_client']] as const) {
    const { db } = fakeDb(() => ({ error: { code: sqlstate, message: 'refus' } }));
    await assert.rejects(new SupabaseCheckoutRepository(db).createAttempt(input, {} as never, 'f'.repeat(64)),
      (e: unknown) => e instanceof SignupError && e.code === code);
  }
  const { db } = fakeDb(() => ({ error: { code: '22023', message: 'récapitulatif incohérent' } }));
  await assert.rejects(new SupabaseCheckoutRepository(db).createAttempt(input, {} as never, 'f'.repeat(64)),
    (e: unknown) => e instanceof DatabaseError && e.code === '22023');
});

test('les codes SQL de la finalisation restent lisibles par complete-checkout (P0003, P0004)', async () => {
  const { db } = fakeDb(() => ({ error: { code: 'P0004', message: 'mandat déjà ouvert' } }));
  await assert.rejects(new SupabaseCheckoutRepository(db).complete('a', 't', 'evt', '2026-10-27T00:00:00Z'),
    (e: unknown) => e instanceof DatabaseError && e.code === 'P0004');
});

test('paramètres envoyés aux fonctions SQL : noms exacts de la migration 0900', async () => {
  const { db, calls } = fakeDb(() => ({ data: true }));
  const repo = new SupabaseCheckoutRepository(db);
  await repo.savePayment('a', 't', { sessionId: 's', attemptId: 'a', customerId: 'c', paymentIntentId: 'pi',
    paymentMethodId: 'pm', amountPaidCents: 17800, currency: 'cad', paid: true, paidAt: '2026-10-20T12:00:00Z' });
  await repo.reject('a', 't', { refundId: 're', status: 'pending', amountCents: 17800 }, 'motif');
  await repo.applySubscriptionState({ eventId: 'e', type: 'invoice.paid', subscriptionId: 'sub',
    status: 'active', readAt: '2026-10-20T12:00:00Z' });
  await repo.updateRefundStatus({ attemptId: 'a', refundId: 're', status: 'succeeded' });
  await repo.createAttempt(input, {} as never, 'f'.repeat(64)).catch(() => {});
  assert.deepEqual(calls.map(c => [c.fn, Object.keys(c.params).sort()]), [
    ['checkout_attempt_paid', ['p_amount_cents', 'p_customer_id', 'p_id', 'p_intent_id', 'p_method_id', 'p_session_id', 'p_token']],
    ['checkout_attempt_reject', ['p_id', 'p_reason', 'p_refund_amount_cents', 'p_refund_id', 'p_refund_status', 'p_token']],
    ['apply_stripe_subscription_state', ['p_event_id', 'p_read_at', 'p_status', 'p_subscription_id', 'p_type']],
    ['checkout_attempt_refund_status', ['p_attempt_id', 'p_refund_id', 'p_status']],
    ['checkout_attempt_create', ['p_books_up_to_date', 'p_display_name', 'p_email', 'p_estimated_transactions', 'p_id',
      'p_phone', 'p_quote', 'p_request_fingerprint', 'p_uses_quickbooks']],
    ['checkout_attempt_get', ['p_id']],
  ]);
});

test('lecture d\'une tentative : colonnes SQL → CheckoutAttempt', async () => {
  const row = { id: 'a', created_at: '2026-10-20T12:00:00Z', email: 'x@y.ca', phone: '1', display_name: 'X',
    books_up_to_date: true, uses_quickbooks: false, estimated_transactions: 3, granted_quote: { startsOn: '2026-10-01' },
    stripe_session_id: 'cs', paid_amount_cents: 17800, paid_at: '2026-10-20T12:01:00Z', abandoned_at: null };
  const { db } = fakeDb(c => ({ data: c.fn === 'checkout_attempt_get' ? [row] : null }));
  const a = await new SupabaseCheckoutRepository(db).getAttempt('a');
  assert.equal(a?.paidAmountCents, 17800);
  assert.equal(a?.abandonedAt, null);
  assert.equal(a?.stripeSubscriptionId, null);
  assert.equal(mapAttempt({ ...row, paid_amount_cents: null }).paidAmountCents, null);
  const empty = fakeDb(() => ({ data: [] }));
  assert.equal(await new SupabaseCheckoutRepository(empty.db).getAttempt('b'), null);
});

test('limite d\'appels : réponse de rate_limit_hit, erreur SQL remontée', async () => {
  const ok = fakeDb(() => ({ data: false }));
  assert.equal(await new SupabaseRateLimiter(ok.db).allow('checkout:ip:1.2.3.4', 20, 3600), false);
  assert.deepEqual(ok.calls[0], { fn: 'rate_limit_hit', params: { p_key: 'checkout:ip:1.2.3.4', p_limit: 20, p_window_seconds: 3600 } });
  const ko = fakeDb(() => ({ error: { code: '08006', message: 'connexion perdue' } }));
  await assert.rejects(new SupabaseRateLimiter(ko.db).allow('k', 1, 60), DatabaseError);
});
