import { assertEquals, assertThrows } from "./assert.ts";
import { countMonth, grantTerms, PricingError, termsForMonth } from "../../../_shared/domain/pricing/mod.ts";

const NBSP = " ";
const depart = grantTerms("depart", "monthly");

Deno.test("compteur : sous le quota", () => {
  const c = countMonth(depart, 15);
  assertEquals(c.label, "15 / 20");
  assertEquals(c.extraAmountCents, 0);
  assertEquals(c.warning, false);
});

Deno.test("compteur : avertissement à 80 % du quota", () => {
  assertEquals(countMonth(depart, 16).warning, true);
  assertEquals(countMonth(depart, 17).label, "17 / 20");
});

Deno.test("compteur : transactions supplémentaires à 4,50 $", () => {
  const c = countMonth(depart, 23);
  assertEquals(c.extraTransactions, 3);
  assertEquals(c.extraAmountCents, 1350);
  assertEquals(c.label, `23 / 20 — 3 transactions supplémentaires (13,50${NBSP}$)`);
  assertEquals(countMonth(depart, 21).label, `21 / 20 — 1 transaction supplémentaire (4,50${NBSP}$)`);
});

Deno.test("compteur : le prix accordé prime sur la grille", () => {
  const ancien = { includedTransactions: 20, extraTransactionCents: 400 };
  assertEquals(countMonth(ancien, 25).extraAmountCents, 2000);
});

Deno.test("compteur : sans quota (Sur mesure)", () => {
  const c = countMonth({ includedTransactions: null, extraTransactionCents: 0 }, 180);
  assertEquals(c.extraAmountCents, 0);
  assertEquals(c.label, "180 transactions");
});

Deno.test("compteur : nombre invalide", () => {
  assertEquals(assertThrows(() => countMonth(depart, -1), PricingError).code, "invalid_input");
  assertEquals(assertThrows(() => countMonth(depart, 2.5), PricingError).code, "invalid_input");
});

Deno.test("quota du mois : celui du forfait en vigueur le dernier jour", () => {
  const periods = [
    { planCode: "depart", effectiveFrom: "2026-10-01", effectiveTo: "2026-10-15", includedTransactions: 20, extraTransactionCents: 450 },
    { planCode: "elan", effectiveFrom: "2026-10-15", effectiveTo: null, includedTransactions: 50, extraTransactionCents: 450 },
  ];
  assertEquals(termsForMonth(periods, "2026-10-31")?.planCode, "elan");
  assertEquals(termsForMonth(periods, "2026-09-30"), null);
  // Baisse au 1er novembre : octobre reste au forfait d'octobre.
  const downgrade = [
    { planCode: "elan", effectiveFrom: "2026-10-01", effectiveTo: "2026-11-01", includedTransactions: 50, extraTransactionCents: 450 },
    { planCode: "depart", effectiveFrom: "2026-11-01", effectiveTo: null, includedTransactions: 20, extraTransactionCents: 450 },
  ];
  assertEquals(termsForMonth(downgrade, "2026-10-31")?.planCode, "elan");
  assertEquals(termsForMonth(downgrade, "2026-11-30")?.planCode, "depart");
});
