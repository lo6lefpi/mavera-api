import { assertEquals, assertThrows } from "./assert.ts";
import { PricingError, quoteCheckout } from "../../../_shared/domain/pricing/mod.ts";

const TODAY = "2026-10-20";

Deno.test("inscription : Départ mensuel, mois en cours", () => {
  const q = quoteCheckout({ planCode: "depart", billingOption: "monthly", startMonth: "current", today: TODAY });
  assertEquals(q.startsOn, "2026-10-01");
  assertEquals(q.dueToday.lines, [
    { kind: "opening_fee", amountCents: 9900 },
    { kind: "first_period", amountCents: 7900 },
  ]);
  assertEquals(q.dueToday.totalCents, 17800);
  assertEquals(q.recurring, { amountCents: 7900, cycle: "month", nextChargeOn: "2026-11-01" });
  assertEquals(q.commitmentEndsOn, null);
  assertEquals(q.currentMonthBooksUpdate, null);
  assertEquals(q.extraTransactionCents, 450);
  assertEquals(q.taxesIncluded, false);
});

Deno.test("inscription : engagement de 12 mois, ouverture à moitié prix", () => {
  const q = quoteCheckout({ planCode: "depart", billingOption: "monthly_commitment", startMonth: "current", today: TODAY });
  assertEquals(q.dueToday.totalCents, 4900 + 7900);
  assertEquals(q.commitmentEndsOn, "2027-10-01");
});

Deno.test("inscription : annuel payé aujourd'hui, prochain prélèvement dans un an", () => {
  const q = quoteCheckout({ planCode: "elan", billingOption: "annual", startMonth: "current", today: TODAY });
  assertEquals(q.dueToday.totalCents, 7500 + 149000);
  assertEquals(q.recurring, { amountCents: 149000, cycle: "year", nextChargeOn: "2027-10-01" });
  assertEquals(q.commitmentEndsOn, "2027-10-01");
});

Deno.test("inscription : départ le mois suivant, seulement l'ouverture aujourd'hui", () => {
  const q = quoteCheckout({ planCode: "envol", billingOption: "monthly_commitment", startMonth: "next", today: TODAY });
  assertEquals(q.startsOn, "2026-11-01");
  assertEquals(q.dueToday.lines, [{ kind: "opening_fee", amountCents: 9900 }]);
  assertEquals(q.recurring.nextChargeOn, "2026-11-01");
  assertEquals(q.commitmentEndsOn, "2027-11-01");
  assertEquals(q.currentMonthBooksUpdate, { fromCents: 12000, month: "2026-10-01" });
});

Deno.test("inscription : départ le mois suivant en décembre", () => {
  const q = quoteCheckout({ planCode: "depart", billingOption: "annual", startMonth: "next", today: "2026-12-31" });
  assertEquals(q.startsOn, "2027-01-01");
  assertEquals(q.commitmentEndsOn, "2028-01-01");
});

const chauffeur = { platformIncomeOnly: true, accounts: 1, issuesClientInvoices: false, monthlyTransactions: 12 };

Deno.test("inscription : Trajet à 49 $ + 49 $", () => {
  const q = quoteCheckout({ planCode: "trajet", billingOption: "monthly", startMonth: "current", today: TODAY, trajetProfile: chauffeur });
  assertEquals(q.dueToday.totalCents, 9800);
  assertEquals(q.commitmentEndsOn, null);
});

Deno.test("inscription : Trajet exige les réponses aux critères", () => {
  const err = assertThrows(
    () => quoteCheckout({ planCode: "trajet", billingOption: "monthly", startMonth: "current", today: TODAY }),
    PricingError,
  );
  assertEquals(err.code, "invalid_input");
});

Deno.test("inscription : Trajet refusé si un critère n'est pas rempli, avec les raisons", () => {
  const err = assertThrows(
    () =>
      quoteCheckout({
        planCode: "trajet",
        billingOption: "monthly",
        startMonth: "current",
        today: TODAY,
        trajetProfile: { ...chauffeur, accounts: 2, monthlyTransactions: 18 },
      }),
    PricingError,
  );
  assertEquals(err.code, "not_eligible");
  assertEquals(err.details, ["too_many_accounts", "too_many_transactions"]);
});

Deno.test("inscription : les réponses Trajet n'empêchent pas un autre forfait", () => {
  const q = quoteCheckout({
    planCode: "depart",
    billingOption: "monthly",
    startMonth: "current",
    today: TODAY,
    trajetProfile: { ...chauffeur, accounts: 3 },
  });
  assertEquals(q.terms.planCode, "depart");
});

Deno.test("inscription : choix refusés", () => {
  const cases: [Record<string, string>, string][] = [
    [{ planCode: "sur_mesure", billingOption: "monthly", startMonth: "current" }, "plan_not_purchasable"],
    [{ planCode: "trajet", billingOption: "annual", startMonth: "current" }, "billing_not_offered"],
    [{ planCode: "depart", billingOption: "monthly", startMonth: "hier" }, "invalid_input"],
  ];
  for (const [input, code] of cases) {
    const err = assertThrows(
      () => quoteCheckout({ ...input, today: TODAY } as Parameters<typeof quoteCheckout>[0]),
      PricingError,
    );
    assertEquals(err.code, code, JSON.stringify(input));
  }
  assertEquals(
    assertThrows(
      () => quoteCheckout({ planCode: "depart", billingOption: "monthly", startMonth: "current", today: "2026-02-30" }),
      PricingError,
    ).code,
    "invalid_input",
  );
});
