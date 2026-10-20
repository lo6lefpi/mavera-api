import { quoteCheckout, type CheckoutQuote } from '../domain/pricing/mod.ts';
import { type BillingGateway, type CheckoutRepository, InvalidRequestError, SignupError, type SignupInput } from './ports.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Choix nécessaires au calcul : sert aussi au récapitulatif affiché avant le paiement. */
export type QuoteRequest = Pick<SignupInput,
  'planCode' | 'billingOption' | 'startMonth' | 'trajetProfile' | 'estimatedTransactions'>;

export function prepareQuote(input: QuoteRequest, today: string): CheckoutQuote {
  if (input.planCode === 'trajet') {
    const p = input.trajetProfile;
    if (!p || typeof p.platformIncomeOnly !== 'boolean' ||
        typeof p.issuesClientInvoices !== 'boolean' ||
        !Number.isSafeInteger(p.accounts) || p.accounts < 1 ||
        !Number.isSafeInteger(p.monthlyTransactions) || p.monthlyTransactions < 0) {
      throw new InvalidRequestError('Les quatre critères Trajet sont obligatoires et doivent être valides');
    }
    if (p.monthlyTransactions !== input.estimatedTransactions) {
      throw new InvalidRequestError('Le nombre de transactions Trajet est incohérent');
    }
  }
  // quoteCheckout vérifie l'admissibilité à Trajet (PricingError not_eligible).
  return quoteCheckout({
    planCode: input.planCode, billingOption: input.billingOption,
    startMonth: input.startMonth, today, trajetProfile: input.trajetProfile,
  });
}

export async function startCheckout(
  input: SignupInput,
  deps: { billing: BillingGateway; repository: CheckoutRepository },
  today: string,
): Promise<{ sessionId: string; url: string; attemptId: string; quote: CheckoutQuote }> {
  if (typeof input.attemptId !== 'string' || !UUID.test(input.attemptId)) throw new InvalidRequestError('Identifiant de tentative UUID requis');
  if (typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new InvalidRequestError('Courriel invalide');
  if (typeof input.phone !== 'string' || typeof input.displayName !== 'string' ||
      !input.phone.trim() || !input.displayName.trim()) throw new InvalidRequestError('Coordonnées requises');
  if (!Number.isSafeInteger(input.estimatedTransactions) || input.estimatedTransactions < 0) {
    throw new InvalidRequestError('Nombre de transactions invalide');
  }
  const normalizedInput = { ...input, email: input.email.trim().toLowerCase() };
  const fingerprint = await requestFingerprint(normalizedInput);
  const existing = await deps.repository.getAttempt(input.attemptId);
  if (existing) {
    // Tous les choix doivent être identiques : sinon, nouvelle tentative (nouvel identifiant).
    if (existing.requestFingerprint !== fingerprint) throw new SignupError('attempt_conflict');
    if (existing.stripeSessionId) {
      const session = await deps.billing.getCheckoutSession(existing.stripeSessionId);
      if (!session.url) throw new SignupError('attempt_expired');
      return { ...session, url: session.url, attemptId: input.attemptId, quote: existing.quote };
    }
    // Après 23 heures, ne plus relancer un appel Stripe dont l'idempotence peut avoir expiré.
    if (Date.now() - Date.parse(existing.createdAt) > 23 * 3600_000) {
      throw new SignupError('attempt_expired');
    }
  } else {
    const eligibility = await deps.repository.checkEligibility(normalizedInput.email, input.phone);
    // Ancien client : jamais de réouverture sur la foi d'un courriel tapé sur le site.
    if (eligibility === 'returning') throw new SignupError('returning_client');
    if (eligibility === 'active' || eligibility === 'refused') throw new SignupError('not_allowed');
    await replaceOpenAttempt(normalizedInput.email, deps);
  }
  const quote = existing?.quote ?? prepareQuote(normalizedInput, today);
  const lines = quote.dueToday.lines.map(line => ({
    label: line.kind === 'opening_fee' ? 'Ouverture du dossier' : 'Première période de tenue de livres',
    amountCents: line.amountCents,
  }));
  if (lines.length === 0 || lines.some(line => !Number.isSafeInteger(line.amountCents) || line.amountCents < 0) ||
      lines.reduce((sum, line) => sum + line.amountCents, 0) !== quote.dueToday.totalCents ||
      quote.dueToday.totalCents <= 0) throw new Error('Récapitulatif invalide');
  if (!existing) await deps.repository.createAttempt(normalizedInput, quote, fingerprint);
  // Toujours un nouveau client Stripe : jamais celui d'un dossier retrouvé par courriel.
  const result = await deps.billing.createCheckoutSession({
    attemptId: input.attemptId, email: normalizedInput.email, lines,
    successUrl: input.successUrl, cancelUrl: input.cancelUrl,
    payBefore: quote.recurring.nextChargeOn,
  });
  await deps.repository.saveSession(input.attemptId, result.sessionId);
  return { ...result, attemptId: input.attemptId, quote };
}

/**
 * Empreinte (SHA-256) de tous les choix de la demande. Les adresses de retour
 * n'en font pas partie : elles ne changent rien au contrat.
 */
export async function requestFingerprint(input: SignupInput): Promise<string> {
  const p = input.trajetProfile;
  const canonical = JSON.stringify([
    input.email.trim().toLowerCase(), input.phone.trim(), input.displayName.trim(),
    input.planCode, input.billingOption, input.startMonth, input.estimatedTransactions,
    input.booksUpToDate, input.usesQuickbooks,
    p ? [p.platformIncomeOnly, p.issuesClientInvoices, p.accounts, p.monthlyTransactions] : null,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Une seule inscription ouverte par courriel. Une nouvelle demande remplace
 * l'ancienne : sa session Stripe est d'abord expirée (elle ne pourra plus être
 * payée), puis la tentative est abandonnée. Si l'ancienne a déjà été payée,
 * on attend son traitement au lieu de faire payer une deuxième fois.
 */
async function replaceOpenAttempt(
  email: string, deps: { billing: BillingGateway; repository: CheckoutRepository },
): Promise<void> {
  const openId = await deps.repository.openAttemptFor(email);
  if (!openId) return;
  const open = await deps.repository.getAttempt(openId);
  if (!open || open.paidAt) throw new SignupError('payment_in_progress');
  if (open.stripeSessionId) {
    const outcome = await deps.billing.expireCheckoutSession(open.stripeSessionId);
    if (outcome === 'completed') throw new SignupError('payment_in_progress');
  }
  await deps.repository.abandon(openId);
}
