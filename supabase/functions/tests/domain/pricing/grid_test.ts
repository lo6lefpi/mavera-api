import { assertEquals, assertThrows } from "./assert.ts";
import {
  ANNUAL_MONTHS_CHARGED,
  commitmentEndsOn,
  formatCad,
  getPlan,
  grantTerms,
  PLANS,
  PricingError,
} from "../../../_shared/domain/pricing/mod.ts";
import { prorate } from "../../../_shared/domain/pricing/money.ts";

const NBSP = " ";

Deno.test("grille : prix et quotas décidés en octobre 2026", () => {
  const rows = Object.values(PLANS).map((p) => [p.code, p.monthlyCents, p.includedTransactions, p.includedAccounts]);
  assertEquals(rows, [
    ["trajet", 4900, 15, 1],
    ["depart", 7900, 20, 2],
    ["elan", 14900, 50, 3],
    ["envol", 24900, 100, 5],
  ]);
});

Deno.test("grille : l'annuel vaut 10 mois du prix mensuel", () => {
  for (const plan of Object.values(PLANS)) {
    if (plan.annualCents !== null) {
      assertEquals(plan.annualCents, plan.monthlyCents * ANNUAL_MONTHS_CHARGED, plan.code);
    }
  }
});

Deno.test("grille : frais d'ouverture complets et à moitié prix", () => {
  assertEquals(grantTerms("depart", "monthly").openingFeeCents, 9900);
  assertEquals(grantTerms("depart", "monthly_commitment").openingFeeCents, 4900);
  assertEquals(grantTerms("depart", "annual").openingFeeCents, 4900);
  assertEquals(grantTerms("elan", "monthly").openingFeeCents, 14900);
  assertEquals(grantTerms("elan", "annual").openingFeeCents, 7500);
  assertEquals(grantTerms("envol", "monthly").openingFeeCents, 19900);
  assertEquals(grantTerms("envol", "monthly_commitment").openingFeeCents, 9900);
  assertEquals(grantTerms("trajet", "monthly").openingFeeCents, 4900);
});

Deno.test("grille : QuickBooks inclus seulement pour Trajet et Départ", () => {
  const included = Object.values(PLANS).filter((p) => p.quickbooksIncluded).map((p) => p.code);
  assertEquals(included, ["trajet", "depart"]);
});

Deno.test("conditions accordées : instantané complet pour la base et Stripe", () => {
  assertEquals(grantTerms("elan", "annual"), {
    gridVersion: "2026-10",
    planCode: "elan",
    billingOption: "annual",
    cycle: "year",
    recurringPriceCents: 149000,
    includedTransactions: 50,
    extraTransactionCents: 450,
    includedAccounts: 3,
    extraAccountCents: 1500,
    includedFilingFrequency: "quarterly",
    extraFilingCents: 2500,
    quickbooksIncluded: false,
    openingFeeCents: 7500,
    openingDiscountCents: 7400,
    stripeRecurringLookupKey: "elan_annual_2026_10",
  });
  const monthly = grantTerms("depart", "monthly");
  assertEquals(monthly.stripeRecurringLookupKey, "depart_monthly_2026_10");
  // Le mensuel avec engagement utilise le même prix récurrent que le mensuel.
  assertEquals(grantTerms("depart", "monthly_commitment").stripeRecurringLookupKey, "depart_monthly_2026_10");
});

Deno.test("conditions accordées : rabais d'ouverture selon l'option", () => {
  assertEquals(grantTerms("depart", "monthly").openingDiscountCents, 0);
  assertEquals(grantTerms("depart", "monthly_commitment").openingDiscountCents, 5000);
  assertEquals(grantTerms("envol", "annual").openingDiscountCents, 10000);
  assertEquals(grantTerms("trajet", "monthly").openingDiscountCents, 0);
});

Deno.test("Trajet : mensuel seulement, sans engagement ni annuel", () => {
  assertThrows(() => grantTerms("trajet", "annual"), PricingError, "n'est pas offert");
  assertThrows(() => grantTerms("trajet", "monthly_commitment"), PricingError, "n'est pas offert");
});

Deno.test("Sur mesure et forfaits inconnus ne s'achètent pas", () => {
  const err = assertThrows(() => getPlan("sur_mesure"), PricingError);
  assertEquals(err.code, "plan_not_purchasable");
  assertEquals(assertThrows(() => getPlan("platine"), PricingError).code, "invalid_input");
  assertEquals(assertThrows(() => grantTerms("depart", "weekly"), PricingError).code, "invalid_input");
});

Deno.test("fin d'engagement : 12 mois après le premier mois couvert", () => {
  assertEquals(commitmentEndsOn("2026-10-01", "monthly"), null);
  assertEquals(commitmentEndsOn("2026-10-01", "monthly_commitment"), "2027-10-01");
  assertEquals(commitmentEndsOn("2026-11-01", "annual"), "2027-11-01");
});

Deno.test("format : montants québécois avec espaces insécables", () => {
  assertEquals(formatCad(7900), `79${NBSP}$`);
  assertEquals(formatCad(1350), `13,50${NBSP}$`);
  assertEquals(formatCad(149000), `1${NBSP}490${NBSP}$`);
  assertEquals(formatCad(0), `0${NBSP}$`);
  assertEquals(formatCad(-1350), `−13,50${NBSP}$`);
  assertEquals(assertThrows(() => formatCad(12.5), PricingError).code, "invalid_input");
});

Deno.test("prorata : arrondi au cent, la moitié vers le haut", () => {
  assertEquals(prorate(7000, 12, 31), 2710); // 2709,68
  assertEquals(prorate(5, 1, 2), 3); // 2,5
  assertEquals(prorate(4, 1, 3), 1); // 1,33
  assertEquals(prorate(-5, 1, 2), -3);
});
