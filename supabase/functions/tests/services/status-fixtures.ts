import { quoteCheckout } from '../../_shared/domain/pricing/mod.ts';
import type { CheckoutSessionState, CheckoutStatusSnapshot } from '../../_shared/services/ports.ts';

export const STATUS_SESSION = 'cs_test_status123';

export function statusFixture(planCode = 'depart'): CheckoutStatusSnapshot {
  return {
    id: '7fc50a4e-ec4b-47e3-998a-3d5f99e55b91', stripeSessionId: STATUS_SESSION,
    quote: quoteCheckout({ planCode, billingOption: 'monthly', startMonth: 'current', today: '2026-10-20',
      trajetProfile: { platformIncomeOnly: true, issuesClientInvoices: false, accounts: 1 } }),
    paidAt: null, paidAmountCents: null, completedAt: null, rejectedAt: null,
    refundId: null, refundAmountCents: null, dossierExists: false,
  };
}

export function stripeState(a = statusFixture()): CheckoutSessionState {
  return { sessionId: a.stripeSessionId, attemptId: a.id, mode: 'payment', status: 'complete',
    paymentStatus: 'paid', paymentIntentStatus: 'succeeded' };
}
