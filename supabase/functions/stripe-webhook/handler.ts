/**
 * Webhook Stripe. La signature est vérifiée avant tout. Chaque événement est
 * dirigé vers un service; une erreur répond 500 pour que Stripe renvoie
 * l'événement plus tard (jusqu'à 3 jours) : c'est ce qui rend les reprises
 * automatiques (remboursement refusé, dossier pas encore créé, panne).
 */
import {
  checkoutEvent,
  expiredCheckout,
  refundSignal,
  subscriptionSignal,
  verifyWebhook,
} from '../_shared/integrations/stripe/webhook.ts';
import { completeCheckout } from '../_shared/services/complete-checkout.ts';
import type { BillingGateway, CheckoutRepository } from '../_shared/services/ports.ts';
import { closeExpiredSession, syncRefund, syncSubscription } from '../_shared/services/sync-billing.ts';

export interface WebhookDeps {
  verify?: typeof verifyWebhook;
  services(): { billing: BillingGateway; repository: CheckoutRepository };
}

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export async function handleStripeWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (request.method !== 'POST') return text('Méthode non permise', 405);
  let event;
  try {
    event = await (deps.verify ?? verifyWebhook)(await request.text(), request.headers.get('stripe-signature'));
  } catch {
    return text('Signature Stripe invalide', 400);
  }
  try {
    const checkout = checkoutEvent(event);
    if (checkout) {
      const outcome = await completeCheckout(checkout.attemptId, event.id, deps.services());
      // Un autre traitement tient le verrou : Stripe renverra l'événement.
      if (outcome === 'busy') return text('Traitement en cours, réessayer', 503);
      // 'pending' : paiement asynchrone, l'événement async_payment_succeeded suivra.
      return text(outcome, 200);
    }
    const subscription = subscriptionSignal(event);
    if (subscription) {
      await syncSubscription(subscription, deps.services());
      return text('ok', 200);
    }
    const refund = refundSignal(event);
    if (refund) {
      // 'not_recorded' lève une erreur → 500 : Stripe renverra l'événement.
      return text(await syncRefund(refund, deps.services()), 200);
    }
    const expired = expiredCheckout(event);
    if (expired) return text(await closeExpiredSession(expired.attemptId, deps.services()), 200);
    return text('ignoré', 200);
  } catch (error) {
    console.error('stripe-webhook : échec', event.type, event.id,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return text('Échec temporaire', 500);
  }
}
