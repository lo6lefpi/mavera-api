/**
 * Événements Stripe → faits typés pour les services. La signature est
 * vérifiée avant tout; le contenu de l'événement sert seulement à savoir quoi
 * relire chez Stripe, jamais de preuve de paiement.
 */
import type { RefundSignal, SubscriptionSignal } from '../../services/ports.ts';
import { signatureVerifier, Stripe } from './client.ts';

export async function verifyWebhook(body: string, signature: string | null): Promise<Stripe.Event> {
  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!signature || !secret) throw new Error('Signature Stripe ou secret webhook manquant');
  return await signatureVerifier().webhooks.constructEventAsync(
    body, signature, secret, undefined, Stripe.createSubtleCryptoProvider(),
  );
}

const CHECKOUT_EVENTS = new Set([
  'checkout.session.completed',
  // Paiements asynchrones (débit préautorisé) : le dossier se crée seulement à la confirmation.
  'checkout.session.async_payment_succeeded',
]);

export function checkoutEvent(event: Stripe.Event): { attemptId: string } | null {
  if (!CHECKOUT_EVENTS.has(event.type)) return null;
  const session = event.data.object as Stripe.Checkout.Session;
  const attemptId = session.metadata?.attempt_id;
  return attemptId ? { attemptId } : null;
}

/**
 * Événement d'abonnement ou de facture → signal seulement : le statut n'est
 * jamais lu dans l'événement (ordre d'arrivée non garanti), le service le relit
 * chez Stripe.
 */
export function subscriptionSignal(event: Stripe.Event): SubscriptionSignal | null {
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as Stripe.Invoice;
    const details = invoice.parent?.subscription_details;
    const parent = details?.subscription;
    const subscriptionId = typeof parent === 'string' ? parent : parent?.id;
    // Facture sans abonnement, ou abonnement qui ne vient pas d'une inscription : ignorée.
    if (!subscriptionId || !details?.metadata?.attempt_id) return null;
    return { eventId: event.id, type: event.type, subscriptionId };
  }
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const sub = event.data.object as Stripe.Subscription;
    // Seuls les abonnements créés par une inscription portent attempt_id.
    if (!sub.metadata?.attempt_id) return null;
    return { eventId: event.id, type: event.type, subscriptionId: sub.id };
  }
  return null;
}

/** Suivi d'un remboursement d'inscription (refund.updated, refund.failed) : le statut sera relu. */
export function refundSignal(event: Stripe.Event): RefundSignal | null {
  if (event.type !== 'refund.updated' && event.type !== 'refund.failed') return null;
  const refund = event.data.object as Stripe.Refund;
  // Seuls les remboursements d'inscription portent attempt_id.
  const attemptId = refund.metadata?.attempt_id;
  return attemptId ? { refundId: refund.id, attemptId } : null;
}

/** Session de paiement expirée : elle ne pourra plus être payée. */
export function expiredCheckout(event: Stripe.Event): { attemptId: string } | null {
  if (event.type !== 'checkout.session.expired') return null;
  const attemptId = (event.data.object as Stripe.Checkout.Session).metadata?.attempt_id;
  return attemptId ? { attemptId } : null;
}
