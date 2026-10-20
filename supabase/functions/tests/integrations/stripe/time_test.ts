import { assertEquals, assertThrows } from '../../domain/pricing/assert.ts';
import { checkoutExpiresAt, nextAnchor, torontoMidnight } from '../../../_shared/integrations/stripe/time.ts';
import { BillingTerminalError } from '../../../_shared/services/ports.ts';

const iso = (s: number) => new Date(s * 1000).toISOString();

Deno.test('minuit à Montréal : heure d\'été (UTC−4) et heure normale (UTC−5)', () => {
  assertEquals(iso(torontoMidnight('2026-11-01')), '2026-11-01T04:00:00.000Z'); // jour du changement d'heure
  assertEquals(iso(torontoMidnight('2026-12-01')), '2026-12-01T05:00:00.000Z');
  assertEquals(iso(torontoMidnight('2027-03-14')), '2027-03-14T05:00:00.000Z');
  assertEquals(iso(torontoMidnight('2027-07-01')), '2027-07-01T04:00:00.000Z');
});

Deno.test('ancrage suivant : un mois ou un an, toujours le 1er', () => {
  assertEquals(nextAnchor('2026-11-01', 'month'), '2026-12-01');
  assertEquals(nextAnchor('2026-12-01', 'month'), '2027-01-01');
  assertEquals(nextAnchor('2026-10-01', 'year'), '2027-10-01');
  assertThrows(() => nextAnchor('2026-10-15', 'month'), Error);
});

Deno.test('session : expire 15 min avant le prélèvement, 24 h au plus', () => {
  const midnight = torontoMidnight('2026-11-01');
  // Le 20 octobre : 24 h moins 2 min de marge.
  const oct20 = torontoMidnight('2026-10-20') + 9 * 3600;
  assertEquals(checkoutExpiresAt('2026-11-01', oct20), oct20 + 24 * 3600 - 120);
  // Le 31 octobre à 20 h : coupée à 23 h 45.
  assertEquals(checkoutExpiresAt('2026-11-01', midnight - 4 * 3600), midnight - 15 * 60);
  // 23 h 40 : trop court pour Stripe (30 min minimum).
  assertThrows(() => checkoutExpiresAt('2026-11-01', midnight - 20 * 60), BillingTerminalError, 'checkout_window_closed');
});
