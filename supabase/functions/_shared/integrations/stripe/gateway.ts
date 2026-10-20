/**
 * BillingGateway réel. Aucune règle commerciale ici : les montants, les dates
 * et les conditions viennent de domain/pricing, par la tentative enregistrée.
 * Chaque création chez Stripe a une clé d'idempotence liée à la tentative.
 */
import {
  BillingTerminalError,
  type BillingGateway,
  type PaymentProof,
  type RefundResult,
  type RefundStatus,
  type SessionExpiry,
} from '../../services/ports.ts';
import { stripeClient, type Stripe } from './client.ts';
import { productIdOf, resolveRecurringPrice } from './prices.ts';
import { checkoutExpiresAt, nextAnchor, torontoMidnight } from './time.ts';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const idOf = (value: string | { id: string } | null | undefined): string =>
  typeof value === 'string' ? value : value?.id ?? '';
const REFUND_STATUSES: ReadonlySet<string> = new Set(['pending', 'succeeded', 'failed', 'canceled', 'requires_action']);
/** Statut inconnu ou absent : traité comme non accepté (jamais comme réussi). */
const refundStatusOf = (status: string | null): RefundStatus =>
  status && REFUND_STATUSES.has(status) ? status as RefundStatus : 'requires_action';

export class StripeGateway implements BillingGateway {
  private stripe = stripeClient();

  async createCheckoutSession(input: Parameters<BillingGateway['createCheckoutSession']>[0]) {
    // Avant toute création : la session doit expirer avant le prélèvement du 1er.
    const expiresAt = checkoutExpiresAt(input.payBefore, nowSeconds());
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'cad',
      locale: 'fr-CA',
      expires_at: expiresAt,
      // Toujours un nouveau client Stripe : jamais celui d'un dossier retrouvé par courriel.
      customer_creation: 'always',
      customer_email: input.email,
      client_reference_id: input.attemptId,
      metadata: { attempt_id: input.attemptId },
      payment_intent_data: {
        // Enregistre la carte pour les prélèvements de l'abonnement.
        setup_future_usage: 'off_session',
        metadata: { attempt_id: input.attemptId },
      },
      // Débit préautorisé (ACSS) : seulement après validation du paiement asynchrone en bac à sable.
      payment_method_types: ['card'],
      line_items: input.lines.map(line => ({
        price_data: { currency: 'cad', product_data: { name: line.label }, unit_amount: line.amountCents },
        quantity: 1,
      })),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }, { idempotencyKey: `checkout:create:${input.attemptId}` });
    if (!session.url) throw new Error('Stripe ne fournit aucune adresse de paiement');
    return { sessionId: session.id, url: session.url };
  }

  async getCheckoutSession(sessionId: string) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    // Une session expirée ou terminée n'a plus d'adresse utilisable.
    return { sessionId: session.id, url: session.status === 'open' ? session.url : null };
  }

  /**
   * Empêche l'ancienne session d'être payée. Si l'expiration échoue (session
   * payée entre-temps), l'état réel est relu : une session « complete »
   * signifie qu'un paiement est en cours de traitement.
   */
  async expireCheckoutSession(sessionId: string): Promise<SessionExpiry> {
    const before = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (before.status === 'complete') return 'completed';
    if (before.status === 'expired') return 'already_expired';
    try {
      await this.stripe.checkout.sessions.expire(sessionId);
      return 'expired';
    } catch (error) {
      const after = await this.stripe.checkout.sessions.retrieve(sessionId);
      if (after.status === 'complete') return 'completed';
      if (after.status === 'expired') return 'already_expired';
      throw error;
    }
  }

  /** Relu chez Stripe à chaque fois : le contenu de l'événement ne suffit pas. */
  async getPaymentProof(sessionId: string): Promise<PaymentProof> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);
    if (session.mode !== 'payment') throw new Error('Session Stripe non conforme');
    const attemptId = session.metadata?.attempt_id ?? '';
    const intentId = idOf(session.payment_intent);
    if (!intentId) {
      return { sessionId, attemptId, customerId: '', paymentIntentId: '', paymentMethodId: '',
        amountPaidCents: 0, currency: session.currency ?? '', paid: false, paidAt: null };
    }
    const intent = await this.stripe.paymentIntents.retrieve(intentId, { expand: ['latest_charge'] });
    const charge = intent.latest_charge as Stripe.Charge | string | null;
    const paid = session.payment_status === 'paid' && intent.status === 'succeeded';
    return {
      sessionId, attemptId,
      customerId: idOf(session.customer),
      paymentIntentId: intent.id,
      paymentMethodId: idOf(intent.payment_method),
      amountPaidCents: intent.amount_received,
      currency: intent.currency,
      paid,
      paidAt: paid && charge && typeof charge !== 'string' ? new Date(charge.created * 1000).toISOString() : null,
    };
  }

  /** Retrouve l'abonnement d'une tentative quand la clé d'idempotence a expiré (après 24 h). */
  async findSubscriptionForAttempt(customerId: string, attemptId: string) {
    for await (const sub of this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) {
      if (sub.metadata?.attempt_id === attemptId) {
        const price = sub.items.data[0]?.price;
        if (!price) throw new Error('Abonnement Stripe sans prix');
        return { subscriptionId: sub.id, priceId: price.id, status: sub.status };
      }
    }
    return null;
  }

  /**
   * Abonnement ancré au 1er du mois (00:00 à Montréal), sans prorata : rien
   * n'est facturé avant l'ancrage, puisque le montant du jour a été encaissé
   * par la session de paiement.
   *
   * Traitement tardif : si le client a payé avant l'ancrage mais que le
   * webhook est traité après (panne, reprise de Stripe), on ne rembourse pas.
   * L'abonnement est ancré au cycle suivant, et le cycle qui vient de
   * commencer est facturé tout de suite, au prix accordé, sur la première
   * facture. À valider en bac à sable (première facture et add_invoice_items).
   */
  async createSubscription(input: Parameters<BillingGateway['createSubscription']>[0]) {
    const price = await resolveRecurringPrice(
      this.stripe, input.recurringLookupKey, input.recurringPriceCents, input.cycle,
    );
    const now = nowSeconds();
    const paidAt = Math.floor(Date.parse(input.paidAt) / 1000);
    if (!Number.isFinite(paidAt)) throw new Error('Date de paiement manquante');

    let anchorOn = input.anchorOn;
    const missedCycles: string[] = [];
    if (torontoMidnight(anchorOn) <= now + 60) {
      if (paidAt >= torontoMidnight(anchorOn)) {
        // Impossible avec la fenêtre de paiement, mais jamais facturé à l'aveugle.
        throw new BillingTerminalError('paid_after_anchor');
      }
      while (torontoMidnight(anchorOn) <= now + 60) {
        missedCycles.push(anchorOn);
        anchorOn = nextAnchor(anchorOn, input.cycle);
      }
      if (missedCycles.length > 1) throw new BillingTerminalError('anchor_expired');
    }

    const sub = await this.stripe.subscriptions.create({
      customer: input.customerId,
      items: [{ price: price.id }],
      default_payment_method: input.paymentMethodId,
      collection_method: 'charge_automatically',
      billing_cycle_anchor: torontoMidnight(anchorOn),
      proration_behavior: 'none',
      ...(missedCycles.length === 1
        ? {
          add_invoice_items: [{
            price_data: { currency: 'cad', product: productIdOf(price), unit_amount: input.recurringPriceCents },
            metadata: { attempt_id: input.attemptId, cycle_starting: missedCycles[0] },
          }],
        }
        : {}),
      metadata: { attempt_id: input.attemptId },
      payment_settings: { save_default_payment_method: 'on_subscription' },
      // L'ancrage fait partie de la clé : une reprise avec un autre ancrage n'est pas un doublon,
      // et findSubscriptionForAttempt empêche déjà un deuxième abonnement.
    }, { idempotencyKey: `subscription:create:${input.attemptId}:${anchorOn}` });
    return { subscriptionId: sub.id, priceId: price.id, status: sub.status };
  }

  /**
   * Rembourse exactement le montant payé. Une reprise réutilise le remboursement
   * déjà accepté (jamais deux remboursements); après un remboursement échoué ou
   * annulé, un nouveau est créé avec une nouvelle clé d'idempotence.
   */
  async refund(input: Parameters<BillingGateway['refund']>[0]): Promise<RefundResult> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error('Montant de remboursement invalide');
    }
    let failedBefore = 0;
    for await (const previous of this.stripe.refunds.list({ payment_intent: input.paymentIntentId, limit: 100 })) {
      if (previous.metadata?.attempt_id !== input.attemptId) continue;
      const status = refundStatusOf(previous.status);
      if (status === 'failed' || status === 'canceled') { failedBefore++; continue; }
      return { refundId: previous.id, status, amountCents: previous.amount };
    }
    const refund = await this.stripe.refunds.create({
      payment_intent: input.paymentIntentId,
      amount: input.amountCents,
      metadata: { attempt_id: input.attemptId, reason: input.reason.slice(0, 300) },
    }, { idempotencyKey: `refund:signup:${input.attemptId}:${failedBefore}` });
    return { refundId: refund.id, status: refundStatusOf(refund.status), amountCents: refund.amount };
  }

  /** L'heure est prise avant la lecture : un état lu plus tôt ne remplace jamais un état plus récent. */
  async getSubscriptionStatus(subscriptionId: string) {
    const readAt = new Date().toISOString();
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    return { status: sub.status, readAt };
  }

  async cancelSubscription(subscriptionId: string, attemptId: string) {
    const current = await this.stripe.subscriptions.retrieve(subscriptionId);
    if (current.status === 'canceled') return;
    await this.stripe.subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false },
      { idempotencyKey: `subscription:cancel:${attemptId}` });
  }
}
