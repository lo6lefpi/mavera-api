// deno-lint-ignore-file require-await -- faux dépôt : mêmes signatures async que le vrai, sans attente réelle.
/** Faux dépôt pour les tests de services et d'API : uniquement pour les tests. */
import type { CheckoutAttempt, CheckoutQuote, CheckoutRepository, CheckoutStatusSnapshot, Eligibility, PaymentProof, RefundResult,
  RefundState, RefundSync, SignupInput, StripeSubscriptionRecord, SubscriptionState } from '../../_shared/services/ports.ts';

/** Mêmes règles que les fonctions SQL, en mémoire. */
export class FakeRepository implements CheckoutRepository {
  attempts = new Map<string, CheckoutAttempt>();
  statusSnapshots = new Map<string, CheckoutStatusSnapshot>();
  eligibility: Eligibility = 'new';
  token: string | null = null;
  completeCalls = 0;
  failOnce = false;
  reasons = new Map<string, string>();
  refundStatus = new Map<string, string>();
  states: SubscriptionState[] = [];
  checkEligibility(): Promise<Eligibility> { return Promise.resolve(this.eligibility); }
  async createAttempt(i: SignupInput, quote: CheckoutQuote, requestFingerprint: string) {
    if (await this.openAttemptFor(i.email)) throw new Error('P0005 tentative ouverte');
    const attempt: CheckoutAttempt = { id: i.attemptId, createdAt: new Date().toISOString(),
      email: i.email, phone: i.phone, displayName: i.displayName,
      booksUpToDate: i.booksUpToDate, usesQuickbooks: i.usesQuickbooks,
      estimatedTransactions: i.estimatedTransactions, quote,
      stripeSessionId: null, stripeCustomerId: null, stripePaymentIntentId: null,
      stripeSubscriptionId: null, stripePriceId: null, stripeStatus: null, paidAmountCents: null,
      paidAt: null, completedAt: null, rejectedAt: null, abandonedAt: null, refundId: null, requestFingerprint };
    this.attempts.set(i.attemptId, attempt); return attempt;
  }
  getAttempt(id: string) { return Promise.resolve(this.attempts.get(id) ?? null); }
  async getStatusBySession(sessionId: string) { return this.statusSnapshots.get(sessionId) ?? null; }
  openAttemptFor(email: string) {
    const open = [...this.attempts.values()].find(a => a.email === email &&
      !a.completedAt && !a.rejectedAt && !a.abandonedAt);
    return Promise.resolve(open?.id ?? null);
  }
  async abandon(id: string) {
    const a = this.attempts.get(id)!;
    if (a.paidAt || this.token) throw new Error('P0001 tentative payée ou verrouillée');
    a.abandonedAt = new Date().toISOString();
  }
  async saveSession(id: string, sessionId: string) { this.attempts.get(id)!.stripeSessionId = sessionId; }
  async claim(_id: string, token: string) { if (this.token) return false; this.token = token; return true; }
  async savePayment(id: string, _token: string, proof: PaymentProof) {
    const a = this.attempts.get(id)!;
    a.stripeCustomerId = proof.customerId; a.stripePaymentIntentId = proof.paymentIntentId;
    a.paidAt = proof.paidAt; a.paidAmountCents = proof.amountPaidCents;
  }
  async saveSubscription(id: string, _token: string, s: StripeSubscriptionRecord) {
    const a = this.attempts.get(id)!;
    a.stripeSubscriptionId = s.subscriptionId; a.stripePriceId = s.priceId; a.stripeStatus = s.status;
  }
  async complete(id: string) {
    this.completeCalls++;
    if (this.failOnce) { this.failOnce = false; throw new Error('temporary SQL failure'); }
    this.attempts.get(id)!.completedAt = new Date().toISOString();
    return 'client_id';
  }
  async reject(id: string, _token: string, refund: RefundResult, reason: string) {
    const a = this.attempts.get(id)!;
    // Mêmes exigences que checkout_attempt_reject.
    if (!['pending', 'succeeded'].includes(refund.status) || refund.amountCents !== a.paidAmountCents) {
      throw new Error('22023 remboursement non conforme');
    }
    a.rejectedAt = new Date().toISOString(); a.refundId = refund.refundId;
    this.reasons.set(id, reason); this.refundStatus.set(refund.refundId, refund.status);
  }
  async release() { this.token = null; }
  async applySubscriptionState(state: SubscriptionState) { this.states.push(state); return true; }
  /** Mêmes règles que checkout_attempt_refund_status. */
  async updateRefundStatus(state: RefundState): Promise<RefundSync> {
    const a = this.attempts.get(state.attemptId);
    if (!a) return 'unknown_attempt';
    if (a.refundId === state.refundId) {
      if (!(this.refundStatus.get(state.refundId) === 'succeeded' && state.status === 'pending')) {
        this.refundStatus.set(state.refundId, state.status);
      }
      return 'updated';
    }
    if (!a.rejectedAt && ['pending', 'succeeded', 'requires_action'].includes(state.status)) return 'not_recorded';
    return 'ignored';
  }
}
