import type { BillingGateway, CheckoutRepository, RefundSignal, RefundSync, SubscriptionSignal } from './ports.ts';

/**
 * Événement d'abonnement ou de facture : l'événement n'est qu'un signal. L'état
 * actuel est relu chez Stripe, puis appliqué avec l'heure de cette lecture;
 * l'ordre d'arrivée des événements ne compte donc plus.
 * Erreur si le dossier n'existe pas encore : Stripe renverra l'événement.
 */
export async function syncSubscription(
  signal: SubscriptionSignal,
  deps: { billing: BillingGateway; repository: CheckoutRepository },
): Promise<boolean> {
  const { status, readAt } = await deps.billing.getSubscriptionStatus(signal.subscriptionId);
  return await deps.repository.applySubscriptionState({ ...signal, status, readAt });
}

/**
 * Suivi d'un remboursement : le statut est relu chez Stripe (l'ordre des
 * événements ne compte pas). Un remboursement accepté dont le refus n'est pas
 * encore enregistré donne une erreur : Stripe renverra l'événement.
 * Un échec fait apparaître l'inscription « à traiter ».
 */
export async function syncRefund(
  signal: RefundSignal,
  deps: { billing: BillingGateway; repository: CheckoutRepository },
): Promise<RefundSync> {
  const status = await deps.billing.getRefundStatus(signal.refundId);
  const result = await deps.repository.updateRefundStatus({ ...signal, status });
  if (result === 'not_recorded') throw new Error(`Remboursement ${signal.refundId} pas encore enregistré : réessayer`);
  return result;
}

/**
 * Session de paiement expirée chez Stripe (checkout.session.expired) : elle ne
 * peut plus être payée, la tentative est abandonnée pour libérer le courriel.
 * Une tentative déjà payée ou fermée n'est jamais touchée.
 */
export async function closeExpiredSession(
  attemptId: string, deps: { repository: CheckoutRepository },
): Promise<'abandoned' | 'unchanged' | 'unknown_attempt'> {
  const attempt = await deps.repository.getAttempt(attemptId);
  if (!attempt) return 'unknown_attempt';
  if (attempt.paidAt || attempt.completedAt || attempt.rejectedAt || attempt.abandonedAt) return 'unchanged';
  await deps.repository.abandon(attemptId);
  return 'abandoned';
}
