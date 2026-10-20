import { quoteCheckout, type CheckoutQuote } from '../domain/pricing/mod.ts';
import { type BillingGateway, type CheckoutRepository, SignupError, type SignupInput } from './ports.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function prepareQuote(input: SignupInput, today: string): CheckoutQuote {
  if (input.planCode === 'trajet') {
    const p = input.trajetProfile;
    if (!p || typeof p.platformIncomeOnly !== 'boolean' ||
        typeof p.issuesClientInvoices !== 'boolean' ||
        !Number.isSafeInteger(p.accounts) || p.accounts < 1 ||
        !Number.isSafeInteger(p.monthlyTransactions) || p.monthlyTransactions < 0) {
      throw new Error('Les quatre critères Trajet sont obligatoires et doivent être valides');
    }
    if (p.monthlyTransactions !== input.estimatedTransactions) {
      throw new Error('Le nombre de transactions Trajet est incohérent');
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
  if (!UUID.test(input.attemptId)) throw new Error('Identifiant de tentative UUID requis');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new Error('Courriel invalide');
  if (!input.phone.trim() || !input.displayName.trim()) throw new Error('Coordonnées requises');
  if (!Number.isSafeInteger(input.estimatedTransactions) || input.estimatedTransactions < 0) {
    throw new Error('Nombre de transactions invalide');
  }
  const normalizedInput = { ...input, email: input.email.trim().toLowerCase() };
  const existing = await deps.repository.getAttempt(input.attemptId);
  if (existing) {
    if (existing.email !== normalizedInput.email || existing.quote.terms.planCode !== input.planCode ||
        existing.quote.terms.billingOption !== input.billingOption) {
      throw new Error('Tentative déjà réservée à une autre demande');
    }
    if (existing.stripeSessionId) {
      const session = await deps.billing.getCheckoutSession(existing.stripeSessionId);
      if (!session.url) throw new Error('Session Stripe expirée : nouvelle tentative nécessaire');
      return { ...session, url: session.url, attemptId: input.attemptId, quote: existing.quote };
    }
    // Après 23 heures, ne plus relancer un appel Stripe dont l'idempotence peut avoir expiré.
    if (Date.now() - Date.parse(existing.createdAt) > 23 * 3600_000) {
      throw new Error('Tentative non finalisée : réconciliation nécessaire avant reprise');
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
  if (!existing) await deps.repository.createAttempt(normalizedInput, quote);
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
