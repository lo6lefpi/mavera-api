// deno-lint-ignore-file require-await -- faux Stripe : mêmes signatures async que le vrai, sans attente réelle.
/** Faux Stripe : uniquement pour les tests, sans réseau ni secret. */
import {
  BillingTerminalError,
  type BillingGateway,
  type CheckoutSessionState,
  type PaymentProof,
  type RefundResult,
  type RefundStatus,
  type SessionExpiry,
  type StripeSubscriptionRecord,
} from '../../services/ports.ts';
import { checkoutExpiresAt, nextAnchor, torontoMidnight } from './time.ts';

export class FakeStripeGateway implements BillingGateway {
  sessions = new Map<string, PaymentProof>();
  subscriptions = new Map<string, StripeSubscriptionRecord & {
    attemptId: string; customerId: string; anchorOn: string; immediateInvoiceCents: number;
  }>();
  /** Remboursements par tentative (le dernier accepté ou non). */
  refunds = new Map<string, RefundResult>();
  refundCreates = 0;
  /** Statut des prochains remboursements créés. */
  nextRefundStatus: RefundStatus = 'succeeded';
  /** Montant remboursé imposé (simule un remboursement partiel); par défaut le montant demandé. */
  nextRefundAmountCents: number | null = null;
  /** État des sessions chez Stripe : une session « complete » ne peut plus être expirée. */
  sessionStatus = new Map<string, 'open' | 'complete' | 'expired'>();
  /** États de consultation imposés par les tests, sans mutation des preuves. */
  checkoutStates = new Map<string, CheckoutSessionState>();
  /** Statut d'abonnement relu chez Stripe (getSubscriptionStatus). */
  subscriptionStatus = new Map<string, string>();
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
        customerId: `cus_${++this.seq}`,
        paymentIntentId: `pi_${input.attemptId}`, paymentMethodId: `pm_${input.attemptId}`,
        // Comme Stripe : montant de chaque ligne plus ses taxes.
        amountPaidCents: input.lines.reduce((sum, line) => sum + line.amountCents + line.gstCents + line.qstCents, 0),
        currency: 'cad', paid: this.nextPaid,
        paidAt: this.nextPaid ? (this.paidAt ?? new Date(this.now() * 1000).toISOString()) : null,
      });
    }
    if (!this.sessionStatus.has(id)) this.sessionStatus.set(id, 'open');
    return { sessionId: id, url: `https://checkout.stripe.test/${id}` };
  }

  async getCheckoutSession(sessionId: string) {
    if (!this.sessions.has(sessionId)) throw new Error('Session absente');
    const open = this.sessionStatus.get(sessionId) === 'open';
    return { sessionId, url: open ? `https://checkout.stripe.test/${sessionId}` : null };
  }

  async getCheckoutStatus(sessionId: string): Promise<CheckoutSessionState | null> {
    const state = this.checkoutStates.get(sessionId);
    if (state) return { ...state };
    const proof = this.sessions.get(sessionId);
    if (!proof) return null;
    return {
      sessionId, attemptId: proof.attemptId, mode: 'payment',
      status: this.sessionStatus.get(sessionId) ?? null,
      paymentStatus: proof.paid ? 'paid' : 'unpaid',
      paymentIntentStatus: proof.paid ? 'succeeded' : 'processing',
    };
  }

  async expireCheckoutSession(sessionId: string): Promise<SessionExpiry> {
    const status = this.sessionStatus.get(sessionId);
    if (!status) throw new Error('Session absente');
    if (status === 'complete') return 'completed';
    if (status === 'expired') return 'already_expired';
    this.sessionStatus.set(sessionId, 'expired');
    return 'expired';
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
    if (existing && existing.status !== 'failed' && existing.status !== 'canceled') return { ...existing };
    this.refundCreates++;
    const result: RefundResult = {
      refundId: `re_${input.attemptId}_${this.refundCreates}`,
      status: this.nextRefundStatus,
      amountCents: this.nextRefundAmountCents ?? input.amountCents,
    };
    this.refunds.set(input.attemptId, result);
    return { ...result };
  }

  /** Statut relu chez Stripe; un test peut le modifier dans refunds. */
  async getRefundStatus(refundId: string): Promise<RefundStatus> {
    const refund = [...this.refunds.values()].find(r => r.refundId === refundId);
    if (!refund) throw new Error('Remboursement absent');
    return refund.status;
  }

  async getSubscriptionStatus(subscriptionId: string) {
    const readAt = new Date(this.now() * 1000).toISOString();
    const status = this.subscriptionStatus.get(subscriptionId) ?? this.subscriptions.get(subscriptionId)?.status;
    if (!status) throw new Error('Abonnement absent');
    return { status, readAt };
  }

  async cancelSubscription(subscriptionId: string) {
    this.canceled.add(subscriptionId);
  }
}
