/** Ports sans dépendance à Stripe, Supabase ni réseau. */
import type { CheckoutQuote, BillingOption, IsoDate, StartMonth, TrajetProfile } from '../domain/pricing/mod.ts';
export type { CheckoutQuote, IsoDate };

export interface SignupInput {
  attemptId: string;
  email: string;
  phone: string;
  displayName: string;
  planCode: string;
  billingOption: BillingOption;
  startMonth: StartMonth;
  /** Valeurs du formulaire d'inscription conservées dans la tentative. */
  booksUpToDate: boolean;
  usesQuickbooks: boolean;
  estimatedTransactions: number;
  trajetProfile?: TrajetProfile;
  successUrl: string;
  cancelUrl: string;
}
export type Eligibility = 'new' | 'returning' | 'review' | 'active' | 'refused';
/** Erreur définitive Stripe : impossible d'honorer le devis encaissé. */
export class BillingTerminalError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = 'BillingTerminalError'; this.reason = reason; }
}
export interface PaymentProof {
  sessionId: string;
  attemptId: string;
  customerId: string;
  paymentIntentId: string;
  paymentMethodId: string;
  amountPaidCents: number;
  currency: string;
  paid: boolean;
  /** Heure du paiement (ISO), lue chez Stripe; null tant que ce n'est pas payé. */
  paidAt: string | null;
}
export interface StripeSubscriptionRecord { subscriptionId: string; priceId: string; status: string }
export interface CheckoutAttempt {
  id: string;
  createdAt: string;
  email: string;
  phone: string;
  displayName: string;
  booksUpToDate: boolean;
  usesQuickbooks: boolean;
  estimatedTransactions: number;
  quote: CheckoutQuote;
  stripeSessionId: string | null;
  stripeCustomerId: string | null;
  stripePaymentIntentId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  stripeStatus: string | null;
  paidAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  refundId: string | null;
}
export interface BillingFact {
  eventId: string;
  type: 'invoice.paid' | 'invoice.payment_failed' |
    'customer.subscription.updated' | 'customer.subscription.deleted';
  subscriptionId: string;
  status?: string;
  occurredAt: string;
}
export interface BillingGateway {
  createCheckoutSession(input: {
    attemptId: string;
    email: string;
    lines: ReadonlyArray<{ label: string; amountCents: number }>;
    successUrl: string;
    cancelUrl: string;
    existingCustomerId?: string;
    /** Date du prochain prélèvement (quote.recurring.nextChargeOn) : la session expire avant. */
    payBefore: IsoDate;
  }): Promise<{ sessionId: string; url: string }>;
  getCheckoutSession(sessionId: string): Promise<{ sessionId: string; url: string | null }>;
  getPaymentProof(sessionId: string): Promise<PaymentProof>;
  findSubscriptionForAttempt(customerId: string, attemptId: string): Promise<StripeSubscriptionRecord | null>;
  createSubscription(input: {
    attemptId: string;
    customerId: string;
    paymentMethodId: string;
    recurringLookupKey: string;
    recurringPriceCents: number;
    cycle: 'month' | 'year';
    anchorOn: IsoDate;
    /** Heure du paiement : décide du traitement tardif (après l'ancrage). */
    paidAt: string;
  }): Promise<StripeSubscriptionRecord>;
  refund(input: { attemptId: string; paymentIntentId: string; amountCents?: number; reason: string }): Promise<string>;
  cancelSubscription(subscriptionId: string, attemptId: string): Promise<void>;
}
export interface CheckoutRepository {
  checkEligibility(email: string, phone: string, customerId?: string): Promise<Eligibility>;
  existingCustomerId(email: string): Promise<string | null>;
  createAttempt(input: SignupInput, quote: CheckoutQuote): Promise<CheckoutAttempt>;
  getAttempt(attemptId: string): Promise<CheckoutAttempt | null>;
  saveSession(attemptId: string, sessionId: string): Promise<void>;
  claim(attemptId: string, token: string): Promise<boolean>;
  savePayment(attemptId: string, token: string, proof: PaymentProof): Promise<void>;
  saveSubscription(attemptId: string, token: string, subscription: StripeSubscriptionRecord): Promise<void>;
  complete(attemptId: string, token: string, eventId: string, invitationExpiresAt: string): Promise<string | null>;
  reject(attemptId: string, token: string, refundId: string, reason: string): Promise<void>;
  release(attemptId: string, token: string): Promise<void>;
  recordFact(fact: BillingFact): Promise<boolean>;
}
