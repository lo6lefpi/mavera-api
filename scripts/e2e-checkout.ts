/**
 * Test de bout en bout : site → public-api → Stripe (bac à sable) → webhook → dossier.
 *
 * Prérequis (trois terminaux) :
 *   1. supabase start   puis   supabase functions serve
 *   2. stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook
 *   3. deno run -A --env-file=supabase/functions/.env scripts/e2e-checkout.ts [forfait] [option] [mois] [parcours]
 *        ex. scripts/e2e-checkout.ts depart monthly current
 *
 * Le script crée l'inscription, affiche la page de paiement Stripe (payer avec
 * 4242 4242 4242 4242, n'importe quelle date future et n'importe quel CVC),
 * attend le webhook, puis vérifie Stripe ET la base, et rejoue l'événement
 * pour confirmer qu'aucun deuxième dossier n'est créé.
 */
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { Stripe, STRIPE_API_VERSION } from '../supabase/functions/_shared/integrations/stripe/client.ts';
import { torontoMidnight } from '../supabase/functions/_shared/integrations/stripe/time.ts';
import type { CheckoutQuote } from '../supabase/functions/_shared/domain/pricing/mod.ts';
import type { SignupInput } from '../supabase/functions/_shared/services/ports.ts';
import {
  BANK_ACCOUNTS, createBankCheckout, type E2EContext, e2eFetch, E2E_NETWORK_TIMEOUT_MS, type Scenario, verifyBank, verifyRejected,
} from './e2e-checkout-scenarios.ts';

const [planCode = 'depart', billingOption = 'monthly', startMonth = 'current', scenario = 'card'] = Deno.args;
const results: { ok: boolean; label: string; detail?: string }[] = [];
const check = (ok: boolean, label: string, detail?: string) => {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** URL et clé service_role : variables d'environnement, sinon `supabase status`. */
async function localSupabase(): Promise<{ url: string; serviceKey: string }> {
  let url = Deno.env.get('E2E_SUPABASE_URL') ?? '';
  let serviceKey = Deno.env.get('E2E_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) {
    const out = await new Deno.Command('supabase', { args: ['status', '-o', 'json'], stdout: 'piped', stderr: 'null' }).output();
    if (!out.success) throw new Error('`supabase status` a échoué : Supabase local est-il démarré ?');
    const status = JSON.parse(new TextDecoder().decode(out.stdout)) as Record<string, string>;
    url ||= status.API_URL;
    serviceKey ||= status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  }
  if (!url || !serviceKey) throw new Error('URL ou clé service_role locale introuvable');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) throw new Error(`Supabase LOCAL seulement (reçu : ${url})`);
  return { url, serviceKey };
}

async function main(mode: Scenario) {
  if (!(Deno.env.get('STRIPE_SECRET_KEY') ?? '').startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY doit être une clé de bac à sable (sk_test_…)');
  }
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const site = Deno.env.get('PUBLIC_SITE_ORIGIN');
  if (!webhookSecret || !site) throw new Error('STRIPE_WEBHOOK_SECRET et PUBLIC_SITE_ORIGIN sont requis');
  const { url, serviceKey } = await localSupabase();
  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: e2eFetch },
  });
  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
    apiVersion: STRIPE_API_VERSION, httpClient: Stripe.createFetchHttpClient(e2eFetch),
    timeout: E2E_NETWORK_TIMEOUT_MS, maxNetworkRetries: 0,
  });
  const startedAt = Math.floor(Date.now() / 1000);
  const ctx: E2EContext = { db, stripe, url, site, webhookSecret, startedAt };
  const bank = mode === 'acss-success' || mode === 'acss-failure';

  // 1. Inscription, comme le site
  const attemptId = crypto.randomUUID();

  const email = mode === 'card' ? 'e2e+1792592047468@example.com' : `e2e+${mode}-${attemptId}@example.com`;
  console.log(`\n1. Inscription ${mode} : ${planCode} / ${billingOption} / ${startMonth} (${email})`);
  const signup = {
    attemptId, email, phone: '514 555 0199', displayName: 'Test bout en bout',
    planCode, billingOption, startMonth, booksUpToDate: true, usesQuickbooks: false,
    estimatedTransactions: 12,
    ...(planCode === 'trajet'
      ? { trajetProfile: { platformIncomeOnly: true, issuesClientInvoices: false, accounts: 1, monthlyTransactions: 12 } }
      : {}),
    successUrl: `${site}/commencer/confirmation`, cancelUrl: `${site}/forfaits`,
    captchaToken: Deno.env.get('E2E_CAPTCHA_TOKEN') ?? 'XXXX.DUMMY.TOKEN.XXXX',
  };
  let body: { url: string; quote: CheckoutQuote };
  if (bank) {
    console.log('   Montage ACSS sandbox : /quote → tentative locale → Checkout bancaire → vrai webhook');
    body = await createBankCheckout(ctx, signup as SignupInput);
  } else {
    const res = await e2eFetch(`${url}/functions/v1/public-api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: site },
      body: JSON.stringify(signup),
    });
    body = await res.json();
    if (res.status !== 200) throw new Error(`public-api a répondu ${res.status} : ${JSON.stringify(body)}`);
  }
  const quote = body.quote as CheckoutQuote;
  const $ = (cents: number) => `${(cents / 100).toFixed(2)} $`;
  console.log(`   Aujourd'hui : ${$(quote.dueToday.subtotalCents)} + TPS ${$(quote.dueToday.gstCents)} + TVQ ${$(quote.dueToday.qstCents)} = ${$(quote.dueToday.totalCents)}`);
  console.log(`   Puis ${$(quote.recurring.totalCents)} taxes comprises, à partir du ${quote.recurring.nextChargeOn}`);
  if (mode === 'rejected') {
    // Injection locale avant de montrer la page : simule une ancienne inscription
    // abandonnée dont la session serait néanmoins payée. Le vrai webhook rembourse.
    const { error } = await db.rpc('checkout_attempt_abandon', { p_id: attemptId });
    if (error) throw new Error(`Préparation du refus : ${error.message}`);
    console.log('   Tentative de test abandonnée : le paiement devra être remboursé avant le refus.');
  }
  console.log(`\n2. Payez sur cette page :\n\n   ${body.url}\n`);
  if (bank) {
    const outcome = mode === 'acss-success' ? 'success' : 'failure';
    console.log(`   Choisir le débit bancaire ACSS, institution 000, transit 11000, compte ${BANK_ACCOUNTS[outcome]}.`);
    console.log('   Vérifier les microdépôts : 32 et 45 cents. Le résultat arrive environ trois minutes après.');
    await verifyBank(ctx, attemptId, email, outcome);
    check(true, 'Attente bancaire vérifiée sans dossier ni abonnement');
    if (mode === 'acss-failure') {
      check(true, 'Débit bancaire refusé : aucune création, même après rejeu des événements');
      console.log(`\n✓ Parcours ${mode} réussi. Tentative ${attemptId}`);
      return;
    }
  } else {
    console.log('   Carte de test 4242 4242 4242 4242, date future et CVC quelconque.');
  }
  if (mode === 'rejected') {
    await verifyRejected(ctx, attemptId, email, quote);
    check(true, 'Remboursement complet accepté, refus enregistré, aucun dossier ni abonnement');
    console.log(`\n✓ Parcours ${mode} réussi. Tentative ${attemptId}`);
    return;
  }

  // 2. Attendre le webhook
  type Row = Record<string, unknown>;
  let attempt: Row | undefined;
  let lastState = '';
  for (let i = 0; i < 300; i++) {
    const { data, error } = await db.rpc('checkout_attempt_get', { p_id: attemptId });
    if (error) throw new Error(`Lecture de la tentative : ${error.message}`);
    attempt = (data as Row[])[0];
    const state = attempt?.completed_at ? 'terminée' : attempt?.rejected_at ? 'refusée'
      : attempt?.paid_at ? 'payée, en traitement' : 'en attente du paiement';
    if (state !== lastState) { console.log(`   … ${state}`); lastState = state; }
    if (attempt?.completed_at || attempt?.rejected_at) break;
    await sleep(3000);
  }
  if (!attempt?.completed_at) {
    throw new Error(attempt?.rejected_at
      ? `Inscription refusée : ${attempt.rejection_reason}`
      : 'Aucun dossier après 15 minutes : `stripe listen` tourne-t-il ? Voir aussi les journaux de `supabase functions serve`.');
  }

  // 3. Vérifications chez Stripe
  console.log('\n3. Stripe');
  const intent = await stripe.paymentIntents.retrieve(String(attempt.stripe_payment_intent_id));
  check(intent.amount_received === quote.dueToday.totalCents && intent.currency === 'cad',
    `Encaissé : ${(intent.amount_received / 100).toFixed(2)} $ CAD, taxes comprises`, `attendu ${quote.dueToday.totalCents} cents`);
  const session = await stripe.checkout.sessions.retrieve(String(attempt.stripe_session_id));
  // Notre code calcule la TPS et la TVQ dans domain/pricing ; Stripe applique
  // les mêmes taux fixes, sans Stripe Tax. On vérifie ici la concordance.
  check(session.total_details?.amount_tax === quote.dueToday.gstCents + quote.dueToday.qstCents,
    `Taxes conformes au calcul de notre code (sans Stripe Tax) : ${$(session.total_details?.amount_tax ?? 0)}`,
    `attendu selon notre code : ${quote.dueToday.gstCents + quote.dueToday.qstCents} cents`);
  const sub = await stripe.subscriptions.retrieve(String(attempt.stripe_subscription_id), { expand: ['latest_invoice'] });
  const item = sub.items.data[0];
  check(item?.price.lookup_key === quote.terms.stripeRecurringLookupKey && item?.price.unit_amount === quote.recurring.amountCents,
    `Abonnement au prix accordé (${quote.terms.stripeRecurringLookupKey})`, `reçu ${item?.price.lookup_key} / ${item?.price.unit_amount}`);
  check(sub.billing_cycle_anchor === torontoMidnight(quote.recurring.nextChargeOn),
    `Premier prélèvement le ${quote.recurring.nextChargeOn} à minuit (Montréal)`,
    `ancrage reçu ${new Date(sub.billing_cycle_anchor * 1000).toISOString()}`);
  check(sub.metadata?.attempt_id === attemptId, 'Abonnement relié à la tentative');
  const subRates = (sub.default_tax_rates ?? []).map(r => (typeof r === 'string' ? r : `${r.display_name} ${r.percentage}`)).sort();
  check(subRates.join(',') === 'TPS 5,TVQ 9.975', 'TPS et TVQ ajoutées à chaque prélèvement', subRates.join(','));
  const invoice = sub.latest_invoice as Stripe.Invoice | null;
  check(!invoice || invoice.amount_paid === 0, 'Rien d\'autre facturé avant le premier prélèvement',
    `facture ${invoice?.id} : ${invoice?.amount_paid} cents`);

  // 4. Vérifications dans la base
  console.log('\n4. Base de données');
  check(attempt.paid_amount_cents === quote.dueToday.totalCents, 'Montant payé enregistré');
  const { data: subRow } = await db.from('subscriptions')
    .select('id, mandate_id, billing_option, starts_on, opening_fee_cents, stripe_status')
    .eq('stripe_subscription_id', sub.id).maybeSingle();
  check(!!subRow, 'Abonnement enregistré');
  check(subRow?.billing_option === billingOption && subRow?.starts_on === quote.startsOn &&
    subRow?.opening_fee_cents === quote.terms.openingFeeCents,
    `Option, début (${quote.startsOn}) et frais d'ouverture conformes`, JSON.stringify(subRow));
  const { data: period } = await db.from('subscription_plan_periods')
    .select('plan_code, recurring_price_cents, included_transactions, extra_transaction_cents')
    .eq('subscription_id', subRow?.id ?? '').maybeSingle();
  check(period?.plan_code === planCode && period?.recurring_price_cents === quote.terms.recurringPriceCents &&
    period?.included_transactions === quote.terms.includedTransactions,
    'Conditions accordées figées (forfait, prix, transactions incluses)', JSON.stringify(period));
  const { data: client } = await db.from('clients').select('id, contact_email, stripe_customer_id')
    .eq('stripe_customer_id', String(attempt.stripe_customer_id)).maybeSingle();
  check(client?.contact_email === email, 'Client créé avec le bon courriel et le client Stripe');
  const { count: invites } = await db.from('invitations').select('id', { count: 'exact', head: true })
    .eq('client_id', client?.id ?? '').is('accepted_at', null);
  check(invites === 1, 'Invitation à l\'application en attente');

  // 5. Rejouer l'événement : aucun deuxième dossier
  console.log('\n5. Événement reçu deux fois');
  let event: Stripe.Event | undefined;
  const eventType = bank ? 'checkout.session.async_payment_succeeded' : 'checkout.session.completed';
  for await (const e of stripe.events.list({ type: eventType, created: { gte: startedAt - 60 }, limit: 100 })) {
    if ((e.data.object as Stripe.Checkout.Session).id === attempt.stripe_session_id) { event = e; break; }
  }
  if (!event) {
    check(false, `Événement ${eventType} retrouvé chez Stripe`);
  } else {
    const payload = JSON.stringify(event);
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload, secret: webhookSecret, cryptoProvider: Stripe.createSubtleCryptoProvider(),
    });
    const replay = await e2eFetch(`${url}/functions/v1/stripe-webhook`, {
      method: 'POST', headers: { 'stripe-signature': signature, 'content-type': 'application/json' }, body: payload,
    });
    const text = await replay.text();
    check(replay.status === 200 && text === 'already_completed', 'Rejoué : reconnu comme déjà traité', `${replay.status} ${text}`);
    const { count: subs } = await db.from('subscriptions').select('id', { count: 'exact', head: true })
      .eq('mandate_id', subRow?.mandate_id ?? '');
    check(subs === 1, 'Toujours un seul abonnement pour ce mandat');
  }

  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${failed ? `✗ ${failed} vérification(s) en échec` : '✓ Parcours complet réussi'} (${results.length} vérifications)`);
  console.log(`  Tentative ${attemptId}`);
  if (failed) Deno.exit(1);
}

if (import.meta.main) {
  try {
    if (!['card', 'acss', 'acss-success', 'acss-failure', 'rejected'].includes(scenario)) {
      throw new Error('Parcours inconnu : card, acss (les deux résultats), acss-success, acss-failure ou rejected');
    }
    for (const mode of scenario === 'acss' ? ['acss-success', 'acss-failure'] as const : [scenario as Scenario]) {
      await main(mode);
    }
  } catch (error) {
    console.error(`\nÉchec : ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}
