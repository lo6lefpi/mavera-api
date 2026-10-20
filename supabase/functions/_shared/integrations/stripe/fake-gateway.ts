// deno-lint-ignore-file require-await -- faux Stripe : mêmes signatures async que le vrai, sans attente réelle.
/** Faux Stripe : uniquement pour les tests, sans réseau ni secret. */
import {
  BillingTerminalError,
  type BillingGateway,
  type PaymentProof,
  type StripeSubscriptionRecord,
} from '../../services/ports.ts';
import { checkoutExpiresAt, nextAnchor, torontoMidnight } from './time.ts';

export class FakeStripeGateway implements BillingGateway {
  sessions = new Map<string, PaymentProof>();
  subscriptions = new Map<string, StripeSubscriptionRecord & {
    attemptId: string; customerId: string; anchorOn: string; immediateInvoiceCents: number;
  }>();
  refunds = new Map<string, string>();
  canceled = new Set<string>();
  subscriptionCreates = 0;
  checkoutCreates = 0;
  /** Le prochain paiement réussit-il ? */
  nextPaid = true;
  /** Heure simulée (secondes Unix); par défaut, l'heure réelle. */
  nowSeconds: number | null = null;
  /** Heure de paiement simulée (ISO); par défaut, l'heure simulée. */
  paidAt: string | null = null;
  private seq = 0;

  private now(): number {
    return this.nowSeconds ?? Math.floor(Date.now() / 1000);
  }

  async createCheckoutSession(input: Parameters<BillingGateway['createCheckoutSession']>[0]) {
    checkoutExpiresAt(input.payBefore, this.now()); // même refus que le vrai Stripe
    this.checkoutCreates++;
    const id = `cs_test_${input.attemptId}`;
    if (!this.sessions.has(id)) {
      this.sessions.set(id, {
        sessionId: id, attemptId: input.attemptId,
        customerId: input.existingCustomerId ?? `cus_${++this.seq}`,
        paymentIntentId: `pi_${input.attemptId}`, paymentMethodId: `pm_${input.attemptId}`,
        amountPaidCents: input.lines.reduce((sum, line) => sum + line.amountCents, 0),
        currency: 'cad', paid: this.nextPaid,
        paidAt: this.nextPaid ? (this.paidAt ?? new Date(this.now() * 1000).toISOString()) : null,
      });
    }
    return { sessionId: id, url: `https://checkout.stripe.test/${id}` };
  }

  async getCheckoutSession(sessionId: string) {
    if (!this.sessions.has(sessionId)) throw new Error('Session absente');
    return { sessionId, url: `https://checkout.stripe.test/${sessionId}` };
  }

  async getPaymentProof(sessionId: string) {
    const proof = this.sessions.get(sessionId);
    if (!proof) throw new Error('Session absente');
    // Un test peut marquer la session payée après coup : l'heure du paiement suit alors.
    if (proof.paid && !proof.paidAt) proof.paidAt = this.paidAt ?? new Date(this.now() * 1000).toISOString();
    return { ...proof };
  }

  async findSubscriptionForAttempt(customerId: string, attemptId: string) {
    const item = [...this.subscriptions.values()].find(x => x.customerId === customerId && x.attemptId === attemptId);
    return item ? { subscriptionId: item.subscriptionId, priceId: item.priceId, status: item.status } : null;
  }

  /** Mêmes règles d'ancrage que le vrai adaptateur. */
  async createSubscription(input: Parameters<BillingGateway['createSubscription']>[0]) {
    const now = this.now();
    const paidAt = Math.floor(Date.parse(input.paidAt) / 1000);
    let anchorOn = input.anchorOn;
    let missed = 0;
    if (torontoMidnight(anchorOn) <= now + 60) {
      if (paidAt >= torontoMidnight(anchorOn)) throw new BillingTerminalError('paid_after_anchor');
      while (torontoMidnight(anchorOn) <= now + 60) {
        missed++;
        anchorOn = nextAnchor(anchorOn, input.cycle);
      }
      if (missed > 1) throw new BillingTerminalError('anchor_expired');
    }
    this.subscriptionCreates++;
    const id = `sub_${input.attemptId}`;
    const record = {
      subscriptionId: id, priceId: `price_${input.recurringLookupKey}`, status: 'active',
      attemptId: input.attemptId, customerId: input.customerId, anchorOn,
      immediateInvoiceCents: missed * input.recurringPriceCents,
    };
    this.subscriptions.set(id, record);
    return { subscriptionId: id, priceId: record.priceId, status: record.status };
  }

  async refund(input: Parameters<BillingGateway['refund']>[0]) {
    const existing = this.refunds.get(input.attemptId);
    if (existing) return existing;
    const id = `re_${input.attemptId}`;
    this.refunds.set(input.attemptId, id);
    return id;
  }

  async cancelSubscription(subscriptionId: string) {
    this.canceled.add(subscriptionId);
  }
}
