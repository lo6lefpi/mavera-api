/** Scénarios E2E supplémentaires : vrais objets Stripe sandbox et vraie base locale. */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.2';
import { Stripe } from '../supabase/functions/_shared/integrations/stripe/client.ts';
import { checkoutSuccessUrl } from '../supabase/functions/_shared/integrations/stripe/gateway.ts';
import { quebecTaxRateIds } from '../supabase/functions/_shared/integrations/stripe/taxes.ts';
import { checkoutExpiresAt } from '../supabase/functions/_shared/integrations/stripe/time.ts';
import { SupabaseCheckoutRepository } from '../supabase/functions/_shared/integrations/supabase/repository.ts';
import { requestFingerprint } from '../supabase/functions/_shared/services/start-checkout.ts';
import type { CheckoutQuote, SignupInput } from '../supabase/functions/_shared/services/ports.ts';

export type Scenario = 'card' | 'acss-success' | 'acss-failure' | 'rejected';
export type Row = Record<string, unknown>;
export interface E2EContext {
  db: SupabaseClient;
  stripe: Stripe;
  url: string;
  site: string;
  webhookSecret: string;
  startedAt: number;
}
export const BANK_ACCOUNTS = { success: '900123456789', failure: '900222222227' } as const;
export const E2E_NETWORK_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const idOf = (v: string | { id: string } | null): string => typeof v === 'string' ? v : v?.id ?? '';
export class ArtifactsFoundError extends Error {}

/** Appels JSON du script uniquement : borne aussi la lecture du corps, pas seulement les en-têtes. */
export async function e2eFetch(input: string | URL | Request, init?: RequestInit,
  timeoutMs = E2E_NETWORK_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const response = await fetch(input, { ...init, signal });
    const bytes = await response.arrayBuffer();
    return new Response(bytes.byteLength ? bytes : null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Aucune réponse complète après ${timeoutMs / 1000} secondes`, { cause: error });
    throw error;
  } finally { clearTimeout(timer); }
}

async function step<T>(label: string, run: () => PromiseLike<T>): Promise<T> {
  console.log(`   → ${label}…`);
  const started = Date.now();
  try {
    const result = await run();
    console.log(`   ✓ ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} : ${detail}`, { cause: error });
  }
}

export async function attemptOf(ctx: E2EContext, attemptId: string): Promise<Row> {
  const { data, error } = await ctx.db.rpc('checkout_attempt_get', { p_id: attemptId });
  if (error) throw new Error(`Lecture tentative : ${error.message}`);
  const a = (data as Row[] | null)?.[0];
  if (!a) throw new Error('Tentative de test introuvable');
  return a;
}

export async function paymentOf(ctx: E2EContext, sessionId: string) {
  const session = await ctx.stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.payment_method'],
  });
  if (session.livemode) throw new Error('Session de production interdite');
  const intent = typeof session.payment_intent === 'string'
    ? await ctx.stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['payment_method'] })
    : session.payment_intent;
  return { session, intent };
}

/** Toute erreur de lecture est une erreur de test, jamais une preuve d'absence. */
export async function assertNoArtifacts(ctx: E2EContext, attemptId: string, email: string, customerId: string) {
  const a = await attemptOf(ctx, attemptId);
  if (a.completed_at || a.stripe_subscription_id) throw new ArtifactsFoundError('Dossier ou abonnement enregistré trop tôt');
  const byEmail = await ctx.db.from('clients').select('id', { count: 'exact', head: true }).eq('contact_email', email);
  if (byEmail.error || byEmail.count === null) throw new Error(`Lecture clients : ${byEmail.error?.message ?? 'compte absent'}`);
  if (byEmail.count !== 0) throw new ArtifactsFoundError('Un dossier existe pour le courriel de test');
  if (customerId) {
    const byStripe = await ctx.db.from('clients').select('id', { count: 'exact', head: true }).eq('stripe_customer_id', customerId);
    if (byStripe.error || byStripe.count === null) throw new Error(`Lecture clients Stripe : ${byStripe.error?.message ?? 'compte absent'}`);
    if (byStripe.count !== 0) throw new ArtifactsFoundError('Un dossier existe pour le client Stripe de test');
    // status: all : même un abonnement créé puis annulé ferait échouer le parcours.
    for await (const sub of ctx.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 })) {
      throw new ArtifactsFoundError(`Un abonnement Stripe a été créé (${sub.id}, ${sub.status})`);
    }
  }
}

export async function eventOf(ctx: E2EContext, sessionId: string, type: Stripe.Event.Type): Promise<Stripe.Event> {
  for (let i = 0; i < 30; i++) {
    for await (const e of ctx.stripe.events.list({ type, created: { gte: ctx.startedAt - 60 }, limit: 100 })) {
      if ((e.data.object as Stripe.Checkout.Session).id === sessionId) return e;
    }
    await sleep(2000);
  }
  throw new Error(`Événement réel ${type} introuvable pour la session de test`);
}

/** Rejoue un événement réel du sandbox ; ne fabrique jamais une confirmation bancaire. */
export async function replay(ctx: E2EContext, event: Stripe.Event): Promise<string> {
  if (event.livemode) throw new Error('Rejeu d’un événement de production interdit');
  const payload = JSON.stringify(event);
  const signature = await ctx.stripe.webhooks.generateTestHeaderStringAsync({
    payload, secret: ctx.webhookSecret, cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  for (let i = 0; i < 10; i++) {
    const response = await e2eFetch(`${ctx.url}/functions/v1/stripe-webhook`, {
      method: 'POST', headers: { 'stripe-signature': signature, 'content-type': 'application/json' }, body: payload,
    });
    const result = await response.text();
    if (response.status === 200) return result;
    // Le transfert naturel par stripe listen peut tenir brièvement le verrou.
    if (response.status === 503 && i < 9) { await sleep(500); continue; }
    throw new Error(`Webhook : ${response.status} ${result}`);
  }
  throw new Error('Webhook occupé');
}

/**
 * ACSS n'est pas ouvert dans public-api. Ce montage de test passe par /quote,
 * enregistre la tentative via le vrai dépôt, puis crée une session Checkout
 * bancaire explicitement limitée à ACSS. Le webhook reste inchangé.
 */
export async function createBankCheckout(ctx: E2EContext, input: SignupInput): Promise<{ url: string; quote: CheckoutQuote }> {
  const quote = await step('Lecture du récapitulatif auprès de public-api /quote', async () => {
    const response = await e2eFetch(`${ctx.url}/functions/v1/public-api/quote`, {
      method: 'POST', headers: { origin: ctx.site, 'content-type': 'application/json' }, body: JSON.stringify(input),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status} : ${JSON.stringify(body)}`);
    return body.quote as CheckoutQuote;
  });
  const taxRates = await step('Lecture des taux TPS et TVQ chez Stripe', () => quebecTaxRateIds(ctx.stripe));
  const repository = new SupabaseCheckoutRepository(ctx.db);
  const fingerprint = await requestFingerprint(input);
  await step('Enregistrement de la tentative dans Supabase local', () => repository.createAttempt(input, quote, fingerprint));
  const session = await step('Création de la session Checkout ACSS chez Stripe', () => ctx.stripe.checkout.sessions.create({
    mode: 'payment', currency: 'cad', locale: 'fr-CA', customer_creation: 'always', customer_email: input.email,
    client_reference_id: input.attemptId, metadata: { attempt_id: input.attemptId },
    // Scénario sandbox à méthode imposée : une session carte ne prouverait pas le parcours ACSS.
    // La configuration dynamique seule est refusée par Checkout sur le compte de test.
    payment_method_types: ['acss_debit'],
    // currency dans acss_debit est réservé au mode setup ; ici la devise vient de la session et des lignes.
    payment_method_options: { acss_debit: { verification_method: 'microdeposits',
      mandate_options: { payment_schedule: 'combined', transaction_type: 'business',
        interval_description: `Paiement initial, puis chaque ${quote.recurring.cycle === 'year' ? 'année' : 'mois'} à partir du ${quote.recurring.nextChargeOn}` } } },
    payment_intent_data: { setup_future_usage: 'off_session', metadata: { attempt_id: input.attemptId } },
    line_items: quote.dueToday.lines.map(line => ({
      price_data: { currency: 'cad', unit_amount: line.amountCents, tax_behavior: 'exclusive',
        product_data: { name: line.kind === 'opening_fee' ? 'Ouverture du dossier' : 'Première période de tenue de livres' } },
      quantity: 1, tax_rates: taxRates,
    })),
    expires_at: checkoutExpiresAt(quote.recurring.nextChargeOn, Math.floor(Date.now() / 1000)),
    success_url: checkoutSuccessUrl(input.successUrl), cancel_url: input.cancelUrl,
  }, { idempotencyKey: `e2e:acss-checkout:${input.attemptId}`, timeout: E2E_NETWORK_TIMEOUT_MS, maxNetworkRetries: 0 }));
  if (session.livemode || !session.url || !session.payment_method_types.includes('acss_debit') || session.amount_total !== quote.dueToday.totalCents) {
    await ctx.stripe.checkout.sessions.expire(session.id);
    await repository.abandon(input.attemptId);
    throw new Error('Session ACSS non conforme : annulée avant paiement');
  }
  await step('Enregistrement du lien tentative/session dans Supabase local', () => repository.saveSession(input.attemptId, session.id));
  return { url: session.url, quote };
}

export interface BankState { status: string | null; method: string | null; failed: boolean }

/** Vérification de la transition : un succès immédiat ne prouve pas le parcours asynchrone. */
export async function observeBankOutcome(expected: 'success' | 'failure', deps: {
  read(): Promise<BankState>;
  noArtifacts(): Promise<void>;
  completedWhilePending(): Promise<void>;
  pause(): Promise<void>;
}, maxPolls = 300): Promise<void> {
  let processingObserved = false;
  for (let i = 0; i < maxPolls; i++) {
    const state = await deps.read();
    if (state.method && state.method !== 'acss_debit') throw new Error('Ce parcours exige un paiement ACSS, pas une carte');
    if (state.status === 'processing') {
      // Lecture avant et après les assertions : éviter une fausse alarme si la banque
      // confirme pendant la lecture des ressources et que le webhook crée le dossier.
      const before = state;
      let absenceError: unknown;
      try { await deps.noArtifacts(); } catch (error) {
        if (!(error instanceof ArtifactsFoundError)) throw error;
        absenceError = error;
      }
      const after = await deps.read();
      if (before.method === 'acss_debit' && after.status === 'processing') {
        if (absenceError) throw absenceError;
        if (!processingObserved) {
          await deps.completedWhilePending();
          processingObserved = true;
        }
      }
    }
    if (state.status === 'succeeded' || state.failed) {
      if (!processingObserved) throw new Error('Attente bancaire non observée : utiliser le compte de test avec délai de trois minutes');
      if ((expected === 'success') !== (state.status === 'succeeded')) throw new Error('Résultat bancaire différent du parcours demandé');
      if (expected === 'failure') await deps.noArtifacts();
      return;
    }
    await deps.pause();
  }
  throw new Error('Aucun résultat bancaire après 15 minutes : vérifier les microdépôts et stripe listen');
}

export async function verifyBank(ctx: E2EContext, attemptId: string, email: string, expected: 'success' | 'failure') {
  const a = await attemptOf(ctx, attemptId);
  const sessionId = String(a.stripe_session_id);
  let customerId = '';
  let verificationShown = false;
  await observeBankOutcome(expected, {
    read: async () => {
      const { session, intent } = await paymentOf(ctx, sessionId);
      const verification = intent?.next_action?.verify_with_microdeposits?.hosted_verification_url;
      if (verification && !verificationShown) {
        console.log(`   Vérifiez le compte sur cette page Stripe avec 32 et 45 cents :\n   ${verification}`);
        verificationShown = true;
      }
      customerId = idOf(session.customer);
      if (session.metadata?.attempt_id !== attemptId) throw new Error('Session associée à une autre tentative');
      if (intent?.status === 'processing' && !customerId) throw new Error('Paiement bancaire sans client Stripe');
      const method = intent?.payment_method;
      return { status: intent?.status ?? null,
        method: method && typeof method !== 'string' ? method.type : null,
        failed: intent?.status === 'requires_payment_method' && !!intent.last_payment_error };
    },
    noArtifacts: () => assertNoArtifacts(ctx, attemptId, email, customerId),
    completedWhilePending: async () => {
      const event = await eventOf(ctx, sessionId, 'checkout.session.completed');
      const outcome = await replay(ctx, event);
      const { intent } = await paymentOf(ctx, sessionId);
      if (intent?.status === 'processing' && outcome !== 'pending') throw new Error(`Webhook précoce : ${outcome}, attendu pending`);
      console.log('  ✓ Attente bancaire observée : aucun dossier ni abonnement, même après checkout.session.completed');
    },
    pause: () => sleep(3000),
  });
  if (expected === 'failure') {
    const { session, intent } = await paymentOf(ctx, sessionId);
    if (session.payment_status !== 'unpaid' || intent?.status !== 'requires_payment_method' ||
      !intent.last_payment_error || intent.amount_received !== 0) throw new Error('Le débit bancaire doit avoir échoué sans encaissement');
    const failed = await eventOf(ctx, sessionId, 'checkout.session.async_payment_failed');
    await replay(ctx, failed);
    await replay(ctx, await eventOf(ctx, sessionId, 'checkout.session.completed'));
    await assertNoArtifacts(ctx, attemptId, email, customerId);
    const attempt = await attemptOf(ctx, attemptId);
    if (attempt.paid_at || attempt.rejected_at || attempt.refund_id) throw new Error('Un débit refusé ne doit être ni encaissé ni remboursé');
    console.log('  ✓ Débit refusé par Stripe : aucun dossier, aucun abonnement, aucun remboursement');
  } else {
    console.log('  ✓ Confirmation bancaire reçue ; attente du dossier créé par le webhook');
  }
}

export function assertAcceptedRefund(a: Row, paidCents: number, refund: Pick<Stripe.Refund, 'status' | 'amount'>) {
  if (!a.paid_at || !a.rejected_at || a.completed_at || !a.refund_id || a.paid_amount_cents !== paidCents || a.refund_amount_cents !== paidCents ||
    !['pending', 'succeeded'].includes(String(a.refund_status)) || !['pending', 'succeeded'].includes(String(refund.status)) || refund.amount !== paidCents) {
    throw new Error('Refus invalide : un remboursement complet doit être accepté par Stripe et enregistré avant le refus');
  }
}

export async function verifyRejected(ctx: E2EContext, attemptId: string, email: string, quote: CheckoutQuote) {
  let a = await attemptOf(ctx, attemptId);
  for (let i = 0; i < 300 && !a.rejected_at; i++) {
    if (a.completed_at || a.stripe_subscription_id) throw new Error('Une inscription à refuser a créé un dossier ou un abonnement');
    await sleep(3000); a = await attemptOf(ctx, attemptId);
  }
  if (!a.rejected_at || !a.refund_id) throw new Error('Refus/remboursement non enregistré après 15 minutes');
  const { session, intent } = await paymentOf(ctx, String(a.stripe_session_id));
  if (session.metadata?.attempt_id !== attemptId || session.payment_status !== 'paid' || intent?.status !== 'succeeded' ||
    intent.id !== a.stripe_payment_intent_id || intent.currency !== 'cad' || intent.amount_received !== quote.dueToday.totalCents) {
    throw new Error('Le refus doit suivre un vrai paiement réussi du montant accordé');
  }
  const refund = await ctx.stripe.refunds.retrieve(String(a.refund_id));
  if (idOf(refund.payment_intent) !== intent.id || refund.metadata?.attempt_id !== attemptId) {
    throw new Error('Remboursement associé à un autre paiement ou à une autre tentative');
  }
  assertAcceptedRefund(a, quote.dueToday.totalCents, refund);
  await assertNoArtifacts(ctx, attemptId, email, idOf(session.customer));
  const event = await eventOf(ctx, session.id, 'checkout.session.completed');
  if (await replay(ctx, event) !== 'rejected') throw new Error('Refus non idempotent au rejeu du webhook');
  const refunds = [];
  for await (const r of ctx.stripe.refunds.list({ payment_intent: intent.id, limit: 100 })) refunds.push(r);
  if (refunds.length !== 1 || refunds[0].id !== refund.id) throw new Error('Un deuxième remboursement a été créé');
  a = await attemptOf(ctx, attemptId);
  assertAcceptedRefund(a, quote.dueToday.totalCents, await ctx.stripe.refunds.retrieve(refund.id));
  await assertNoArtifacts(ctx, attemptId, email, idOf(session.customer));
  console.log(`  ✓ Paiement reçu, remboursement complet ${refund.status}, tentative refusée, aucun dossier ni abonnement`);
  console.log('  ✓ Webhook rejoué : toujours un seul remboursement');
}
