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

/**
 * Refus d'une inscription, avant tout paiement. public-api traduit le code en
 * message pour le site.
 * - returning_client : ancien client → réouverture par l'application, où il est authentifié
 * - not_allowed : dossier déjà ouvert, ou client refusé définitivement
 * - payment_in_progress : un paiement pour ce courriel est en cours de traitement
 * - attempt_expired : la tentative ne peut plus être payée; le site recommence avec un nouvel identifiant
 * - attempt_conflict : même identifiant avec d'autres choix; le site recommence avec un nouvel identifiant
 */
export type SignupErrorCode =
  | 'returning_client' | 'not_allowed' | 'payment_in_progress' | 'attempt_expired' | 'attempt_conflict';
export class SignupError extends Error {
  readonly code: SignupErrorCode;
  constructor(code: SignupErrorCode) { super(code); this.name = 'SignupError'; this.code = code; }
}

/** Demande mal formée (champ manquant ou invalide) : jamais une panne. */
export class InvalidRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidRequestError'; }
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

/** Statuts d'un remboursement Stripe. Seuls pending et succeeded permettent d'enregistrer un refus. */
export type RefundStatus = 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action';
export interface RefundResult { refundId: string; status: RefundStatus; amountCents: number }

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
  paidAmountCents: number | null;
  paidAt: string | null;
  completedAt: string | null;
  rejectedAt: string | null;
  abandonedAt: string | null;
  refundId: string | null;
  /** Empreinte des choix de la demande (SHA-256); null pour une tentative plus ancienne. */
  requestFingerprint: string | null;
}

/** Lecture minimale pour le retour du site, sans coordonnées ni motif de refus. */
export interface CheckoutStatusSnapshot {
  id: string;
  stripeSessionId: string;
  quote: CheckoutQuote;
  paidAt: string | null;
  paidAmountCents: number | null;
  completedAt: string | null;
  rejectedAt: string | null;
  refundId: string | null;
  refundAmountCents: number | null;
  dossierExists: boolean;
}

/** Faits Stripe relus sans effet de bord, jamais renvoyés au navigateur. */
export interface CheckoutSessionState {
  sessionId: string;
  attemptId: string;
  mode: string;
  status: string | null;
  paymentStatus: string;
  paymentIntentStatus: string | null;
}

/** Signal d'un événement d'abonnement : l'état réel est relu chez Stripe. */
export interface SubscriptionSignal {
  eventId: string;
  type: 'invoice.paid' | 'invoice.payment_failed' |
    'customer.subscription.updated' | 'customer.subscription.deleted';
  subscriptionId: string;
}
/** État d'abonnement lu chez Stripe, avec l'heure du début de la lecture. */
export interface SubscriptionState extends SubscriptionSignal { status: string; readAt: string }
/** Signal d'un remboursement d'inscription : le statut est relu chez Stripe. */
export interface RefundSignal { refundId: string; attemptId: string }
export interface RefundState extends RefundSignal { status: RefundStatus }
/** Résultat du suivi (voir checkout_attempt_refund_status). */
export type RefundSync = 'updated' | 'not_recorded' | 'ignored' | 'unknown_attempt';

/** Ce que donne la tentative d'expirer une session de paiement chez Stripe. */
export type SessionExpiry = 'expired' | 'already_expired' | 'completed';

export interface BillingGateway {
  createCheckoutSession(input: {
    attemptId: string;
    email: string;
    /** Montants avant taxes, avec la TPS et la TVQ calculées par domain/pricing pour chaque ligne. */
    lines: ReadonlyArray<{ label: string; amountCents: number; gstCents: number; qstCents: number }>;
    successUrl: string;
    cancelUrl: string;
    /** Date du prochain prélèvement (quote.recurring.nextChargeOn) : la session expire avant. */
    payBefore: IsoDate;
  }): Promise<{ sessionId: string; url: string }>;
  getCheckoutSession(sessionId: string): Promise<{ sessionId: string; url: string | null }>;
  getCheckoutStatus(sessionId: string): Promise<CheckoutSessionState | null>;
  /** Empêche une session de paiement d'être payée (remplacement par une nouvelle). */
  expireCheckoutSession(sessionId: string): Promise<SessionExpiry>;
  getPaymentProof(sessionId: string): Promise<PaymentProof>;
  findSubscriptionForAttempt(customerId: string, attemptId: string): Promise<StripeSubscriptionRecord | null>;
  createSubscription(input: {
    attemptId: string;
    customerId: string;
    paymentMethodId: string;
    recurringLookupKey: string;
    /** Prix avant taxes; la TPS et la TVQ s'ajoutent à chaque prélèvement. */
    recurringPriceCents: number;
    cycle: 'month' | 'year';
    anchorOn: IsoDate;
    /** Heure du paiement : décide du traitement tardif (après l'ancrage). */
    paidAt: string;
  }): Promise<StripeSubscriptionRecord>;
  /** Rembourse exactement amountCents (le montant payé). Ne rembourse jamais deux fois. */
  refund(input: { attemptId: string; paymentIntentId: string; amountCents: number; reason: string }): Promise<RefundResult>;
  cancelSubscription(subscriptionId: string, attemptId: string): Promise<void>;
  getSubscriptionStatus(subscriptionId: string): Promise<{ status: string; readAt: string }>;
  getRefundStatus(refundId: string): Promise<RefundStatus>;
}

export interface CheckoutRepository {
  checkEligibility(email: string, phone: string, customerId?: string): Promise<Eligibility>;
  createAttempt(input: SignupInput, quote: CheckoutQuote, requestFingerprint: string): Promise<CheckoutAttempt>;
  getAttempt(attemptId: string): Promise<CheckoutAttempt | null>;
  getStatusBySession(sessionId: string): Promise<CheckoutStatusSnapshot | null>;
  /** Tentative ouverte (ni terminée, ni refusée, ni abandonnée) pour un courriel. */
  openAttemptFor(email: string): Promise<string | null>;
  /** Abandonne une tentative jamais payée, après l'expiration de sa session chez Stripe. */
  abandon(attemptId: string): Promise<void>;
  saveSession(attemptId: string, sessionId: string): Promise<void>;
  claim(attemptId: string, token: string): Promise<boolean>;
  savePayment(attemptId: string, token: string, proof: PaymentProof): Promise<void>;
  saveSubscription(attemptId: string, token: string, subscription: StripeSubscriptionRecord): Promise<void>;
  complete(attemptId: string, token: string, eventId: string, invitationExpiresAt: string): Promise<string | null>;
  reject(attemptId: string, token: string, refund: RefundResult, reason: string): Promise<void>;
  release(attemptId: string, token: string): Promise<void>;
  applySubscriptionState(state: SubscriptionState): Promise<boolean>;
  updateRefundStatus(state: RefundState): Promise<RefundSync>;
}
