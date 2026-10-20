import type { BillingGateway, CheckoutRepository, RefundSignal, SubscriptionSignal } from './ports.ts';

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

/** Suivi d'un remboursement : un échec fait apparaître l'inscription « à traiter ». */
export async function syncRefund(signal: RefundSignal, deps: { repository: CheckoutRepository }): Promise<boolean> {
  return await deps.repository.updateRefundStatus(signal);
}
