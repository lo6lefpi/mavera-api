/**
 * CheckoutRepository réel : chaque méthode appelle une fonction SQL de la
 * migration 0900 avec la clé service_role (jamais exposée au navigateur).
 * Aucune règle ici : les vérifications sont dans les fonctions SQL.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.2';
import {
  type CheckoutAttempt,
  type CheckoutQuote,
  type CheckoutRepository,
  type CheckoutStatusSnapshot,
  type Eligibility,
  type PaymentProof,
  type RefundResult,
  type RefundState,
  type RefundSync,
  SignupError,
  type SignupInput,
  type StripeSubscriptionRecord,
  type SubscriptionState,
} from '../../services/ports.ts';

/** Sous-ensemble du client Supabase utilisé ici : un faux client suffit pour les tests. */
export type RpcClient = Pick<SupabaseClient, 'rpc'>;

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Configuration Supabase incomplète');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Erreur SQL telle que renvoyée par PostgREST (code = SQLSTATE). Le code est conservé. */
export class DatabaseError extends Error {
  readonly code: string;
  readonly details: string | null;
  constructor(fn: string, error: { code?: string; message?: string; details?: string | null }) {
    super(`${fn} : ${error.message ?? 'erreur SQL'}`);
    this.name = 'DatabaseError';
    this.code = error.code ?? '';
    this.details = error.details ?? null;
  }
}

/** Refus prévus par checkout_attempt_create, traduits pour le site. */
const SIGNUP_CODES: Record<string, ConstructorParameters<typeof SignupError>[0]> = {
  P0004: 'not_allowed',
  P0005: 'payment_in_progress',
  P0006: 'returning_client',
};

type Row = Record<string, unknown>;
const text = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function mapAttempt(row: Row): CheckoutAttempt {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    email: String(row.email),
    phone: String(row.phone),
    displayName: String(row.display_name),
    booksUpToDate: row.books_up_to_date === true,
    usesQuickbooks: row.uses_quickbooks === true,
    estimatedTransactions: Number(row.estimated_transactions),
    quote: row.granted_quote as CheckoutQuote,
    stripeSessionId: text(row.stripe_session_id),
    stripeCustomerId: text(row.stripe_customer_id),
    stripePaymentIntentId: text(row.stripe_payment_intent_id),
    stripeSubscriptionId: text(row.stripe_subscription_id),
    stripePriceId: text(row.stripe_price_id),
    stripeStatus: text(row.stripe_status),
    paidAmountCents: row.paid_amount_cents === null || row.paid_amount_cents === undefined
      ? null : Number(row.paid_amount_cents),
    paidAt: text(row.paid_at),
    completedAt: text(row.completed_at),
    rejectedAt: text(row.rejected_at),
    abandonedAt: text(row.abandoned_at),
    refundId: text(row.refund_id),
    requestFingerprint: text(row.request_fingerprint),
  };
}

export class SupabaseCheckoutRepository implements CheckoutRepository {
  constructor(private readonly db: RpcClient = serviceClient()) {}

  private async call<T>(fn: string, params: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, params);
    if (error) throw new DatabaseError(fn, error);
    return data as T;
  }

  checkEligibility(email: string, phone: string, customerId?: string) {
    return this.call<Eligibility>('check_signup_eligibility', {
      p_email: email, p_phone: phone, p_stripe_customer_id: customerId ?? null,
    });
  }

  async createAttempt(input: SignupInput, quote: CheckoutQuote, requestFingerprint: string) {
    try {
      await this.call('checkout_attempt_create', {
        p_id: input.attemptId, p_email: input.email, p_phone: input.phone,
        p_display_name: input.displayName, p_books_up_to_date: input.booksUpToDate,
        p_uses_quickbooks: input.usesQuickbooks,
        p_estimated_transactions: input.estimatedTransactions, p_quote: quote,
        p_request_fingerprint: requestFingerprint,
      });
    } catch (error) {
      const code = error instanceof DatabaseError ? SIGNUP_CODES[error.code] : undefined;
      if (code) throw new SignupError(code);
      throw error;
    }
    const attempt = await this.getAttempt(input.attemptId);
    if (!attempt) throw new Error('Tentative non sauvegardée');
    return attempt;
  }

  async getAttempt(attemptId: string) {
    const rows = await this.call<Row[]>('checkout_attempt_get', { p_id: attemptId });
    return rows && rows.length ? mapAttempt(rows[0]) : null;
  }

  async getStatusBySession(sessionId: string): Promise<CheckoutStatusSnapshot | null> {
    const rows = await this.call<Row[]>('checkout_attempt_status_by_session', { p_session_id: sessionId });
    const row = rows?.[0];
    if (!row) return null;
    return {
      id: String(row.id),
      stripeSessionId: String(row.stripe_session_id),
      quote: row.granted_quote as CheckoutQuote,
      paidAt: text(row.paid_at),
      paidAmountCents: row.paid_amount_cents == null ? null : Number(row.paid_amount_cents),
      completedAt: text(row.completed_at),
      rejectedAt: text(row.rejected_at),
      refundId: text(row.refund_id),
      refundAmountCents: row.refund_amount_cents == null ? null : Number(row.refund_amount_cents),
      dossierExists: row.dossier_exists === true,
    };
  }

  openAttemptFor(email: string) {
    return this.call<string | null>('checkout_attempt_open_for', { p_email: email });
  }

  async abandon(attemptId: string) {
    await this.call('checkout_attempt_abandon', { p_id: attemptId });
  }

  async saveSession(attemptId: string, sessionId: string) {
    await this.call('checkout_attempt_save_session', { p_id: attemptId, p_session_id: sessionId });
  }

  claim(attemptId: string, token: string) {
    return this.call<boolean>('checkout_attempt_claim', { p_id: attemptId, p_token: token });
  }

  async savePayment(attemptId: string, token: string, proof: PaymentProof) {
    await this.call('checkout_attempt_paid', {
      p_id: attemptId, p_token: token, p_session_id: proof.sessionId,
      p_customer_id: proof.customerId, p_intent_id: proof.paymentIntentId,
      p_method_id: proof.paymentMethodId, p_amount_cents: proof.amountPaidCents,
    });
  }

  async saveSubscription(attemptId: string, token: string, subscription: StripeSubscriptionRecord) {
    await this.call('checkout_attempt_subscription', {
      p_id: attemptId, p_token: token, p_subscription_id: subscription.subscriptionId,
      p_price_id: subscription.priceId, p_status: subscription.status,
    });
  }

  complete(attemptId: string, token: string, eventId: string, invitationExpiresAt: string) {
    return this.call<string | null>('checkout_attempt_finish', {
      p_id: attemptId, p_token: token, p_event_id: eventId, p_invitation_expires_at: invitationExpiresAt,
    });
  }

  async reject(attemptId: string, token: string, refund: RefundResult, reason: string) {
    await this.call('checkout_attempt_reject', {
      p_id: attemptId, p_token: token, p_refund_id: refund.refundId,
      p_refund_amount_cents: refund.amountCents, p_refund_status: refund.status, p_reason: reason,
    });
  }

  async release(attemptId: string, token: string) {
    await this.call('checkout_attempt_release', { p_id: attemptId, p_token: token });
  }

  applySubscriptionState(state: SubscriptionState) {
    return this.call<boolean>('apply_stripe_subscription_state', {
      p_event_id: state.eventId, p_type: state.type, p_subscription_id: state.subscriptionId,
      p_status: state.status, p_read_at: state.readAt,
    });
  }

  updateRefundStatus(state: RefundState) {
    return this.call<RefundSync>('checkout_attempt_refund_status', {
      p_attempt_id: state.attemptId, p_refund_id: state.refundId, p_status: state.status,
    });
  }
}

/** Limite d'appels de l'API publique (fenêtre fixe, clé hachée dans la base). */
export class SupabaseRateLimiter {
  constructor(private readonly db: RpcClient = serviceClient()) {}

  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const { data, error } = await this.db.rpc('rate_limit_hit', {
      p_key: key, p_limit: limit, p_window_seconds: windowSeconds,
    });
    if (error) throw new DatabaseError('rate_limit_hit', error);
    return data === true;
  }
}
