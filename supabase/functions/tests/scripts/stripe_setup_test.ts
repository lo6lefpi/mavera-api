import { assertEquals } from '../domain/pricing/assert.ts';
import { expectedRecurringPrices } from '../../../../scripts/stripe-sandbox-setup.ts';

Deno.test('bac à sable : 7 prix d\'abonnement, tirés de la grille', () => {
  const prices = expectedRecurringPrices().map(p => `${p.lookupKey}=${p.amountCents}/${p.interval}`).sort();
  assertEquals(prices, [
    'depart_annual_2026_10_21=79000/year', 'depart_monthly_2026_10_21=7900/month',
    'elan_annual_2026_10_21=149000/year', 'elan_monthly_2026_10_21=14900/month',
    'envol_annual_2026_10_21=249000/year', 'envol_monthly_2026_10_21=24900/month',
    'trajet_monthly_2026_10_21=5900/month',
  ]);
});
