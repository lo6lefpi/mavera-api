import { assertEquals } from '../../domain/pricing/assert.ts';
import { Stripe } from '../../../_shared/integrations/stripe/client.ts';
import { checkoutEvent, refundSignal, subscriptionSignal, verifyWebhook } from '../../../_shared/integrations/stripe/webhook.ts';

const secret = 'whsec_local_test_signature_only';
const sign = (payload: string) =>
  new Stripe('sk_test_unused', { httpClient: Stripe.createFetchHttpClient() })
    .webhooks.generateTestHeaderStringAsync({ payload, secret, cryptoProvider: Stripe.createSubtleCryptoProvider() });
const event = (type: string, object: Record<string, unknown>) =>
  JSON.stringify({ id: `evt_${type}`, object: 'event', type, created: 1792540000, data: { object } });

Deno.test('signature : valide acceptée, falsifiée refusée, sans clé secrète Stripe', async () => {
  Deno.env.set('STRIPE_WEBHOOK_SECRET', secret);
  Deno.env.delete('STRIPE_SECRET_KEY');
  const data = event('checkout.session.completed', {
    id: 'cs_test_a', object: 'checkout.session', metadata: { attempt_id: '22222222-2222-4222-8222-222222222222' },
  });
  const verified = await verifyWebhook(data, await sign(data));
  assertEquals(checkoutEvent(verified), { attemptId: '22222222-2222-4222-8222-222222222222' });
  assertEquals(subscriptionSignal(verified), null);
  assertEquals(refundSignal(verified), null);
  let rejected = false;
  try { await verifyWebhook(data + ' ', await sign(data)); } catch { rejected = true; }
  assertEquals(rejected, true);
});

Deno.test('signaux d\'abonnement : seulement les inscriptions, jamais le statut de l\'événement', async () => {
  Deno.env.set('STRIPE_WEBHOOK_SECRET', secret);
  const ours = event('invoice.paid', { id: 'in_1', object: 'invoice',
    parent: { subscription_details: { subscription: 'sub_1', metadata: { attempt_id: 'a1' } } } });
  const other = event('invoice.paid', { id: 'in_2', object: 'invoice',
    parent: { subscription_details: { subscription: 'sub_2', metadata: {} } } });
  assertEquals(subscriptionSignal(await verifyWebhook(ours, await sign(ours))),
    { eventId: 'evt_invoice.paid', type: 'invoice.paid', subscriptionId: 'sub_1' });
  assertEquals(subscriptionSignal(await verifyWebhook(other, await sign(other))), null);
  const updated = event('customer.subscription.updated', { id: 'sub_1', object: 'subscription',
    status: 'past_due', metadata: { attempt_id: 'a1' } });
  assertEquals(subscriptionSignal(await verifyWebhook(updated, await sign(updated))),
    { eventId: 'evt_customer.subscription.updated', type: 'customer.subscription.updated', subscriptionId: 'sub_1' });
});

Deno.test('remboursements : seulement ceux d\'une inscription, avec un statut connu', async () => {
  Deno.env.set('STRIPE_WEBHOOK_SECRET', secret);
  const failed = event('refund.failed', { id: 're_1', object: 'refund', status: 'failed', metadata: { attempt_id: 'a1' } });
  const other = event('refund.updated', { id: 're_2', object: 'refund', status: 'succeeded', metadata: {} });
  const odd = event('refund.updated', { id: 're_3', object: 'refund', status: 'bizarre', metadata: { attempt_id: 'a1' } });
  assertEquals(refundSignal(await verifyWebhook(failed, await sign(failed))), { refundId: 're_1', status: 'failed' });
  assertEquals(refundSignal(await verifyWebhook(other, await sign(other))), null);
  assertEquals(refundSignal(await verifyWebhook(odd, await sign(odd))), null);
});

Deno.test('le SDK Stripe n\'est importé que dans integrations/stripe', async () => {
  const root = new URL('../../../_shared/', import.meta.url);
  const offenders: string[] = [];
  async function walk(dir: URL) {
    for await (const e of Deno.readDir(dir)) {
      const url = new URL(e.name + (e.isDirectory ? '/' : ''), dir);
      if (e.isDirectory) { if (!url.pathname.includes('/integrations/stripe/')) await walk(url); continue; }
      if (e.name.endsWith('.ts') && /from\s*['"](?:npm:)?stripe(?:@|['"])/.test(await Deno.readTextFile(url))) {
        offenders.push(url.pathname);
      }
    }
  }
  await walk(root);
  assertEquals(offenders, []);
});
