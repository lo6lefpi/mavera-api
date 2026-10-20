import { assertEquals, assertThrows } from "./assert.ts";
import {
  addOnUnitPrice,
  grantTerms,
  coachingCharge,
  extraAccounts,
  filingSupplement,
  PricingError,
  quoteBooksUpdate,
  splitInstallments,
  standaloneFilingPrice,
  suggestPlan,
  trajetEligibility,
} from "../../../_shared/domain/pricing/mod.ts";

Deno.test("mise à jour : 120 $ jusqu'à 20 transactions", () => {
  for (const n of [0, 10, 20]) {
    const q = quoteBooksUpdate({ transactions: n });
    assertEquals(q.totalCents, 12000, String(n));
    assertEquals(q.minimumApplied, true);
  }
});

Deno.test("mise à jour : 6 $ par transaction au-delà de 20", () => {
  const q = quoteBooksUpdate({ transactions: 21 });
  assertEquals(q.totalCents, 12600);
  assertEquals(q.minimumApplied, false);
});

Deno.test("mise à jour : déclarations en retard et accompagnement par demi-heure", () => {
  const q = quoteBooksUpdate({ transactions: 45, overdueFilings: 2, hourlyWorkMinutes: 50 });
  assertEquals(q.lines, [
    { kind: "bookkeeping", quantity: 45, amountCents: 27000 },
    { kind: "overdue_filings", quantity: 2, amountCents: 15000 },
    { kind: "hourly_work", quantity: 2, amountCents: 6000 },
  ]);
  assertEquals(q.totalCents, 48000);
});

Deno.test("mise à jour : les exemples affichés sur le site", () => {
  const total = (r: Parameters<typeof quoteBooksUpdate>[0]) => quoteBooksUpdate(r).totalCents;
  assertEquals(total({ transactions: 5 }), 12000);
  assertEquals(total({ transactions: 20 }), 12000);
  assertEquals(total({ transactions: 30 }), 18000);
  assertEquals(total({ transactions: 30, overdueFilings: 1 }), 25500);
  assertEquals(total({ transactions: 30, overdueFilings: 1, hourlyWorkMinutes: 120 }), 37500);
});

Deno.test("mise à jour : 3 versements au plus, cents restants au premier", () => {
  assertEquals(splitInstallments(10000, 3), [3334, 3333, 3333]);
  assertEquals(splitInstallments(48000, 2), [24000, 24000]);
  assertEquals(splitInstallments(12000, 1), [12000]);
  assertEquals(assertThrows(() => splitInstallments(12000, 4), PricingError).code, "invalid_input");
  assertEquals(assertThrows(() => splitInstallments(12000, 0), PricingError).code, "invalid_input");
});

const terms = {
  trajet: grantTerms("trajet", "monthly"),
  depart: grantTerms("depart", "monthly"),
  elan: grantTerms("elan", "monthly"),
  envol: grantTerms("envol", "monthly"),
};

Deno.test("TPS/TVQ : 25 $ par déclaration au-delà de la fréquence incluse", () => {
  const envolMensuel = filingSupplement(terms.envol, "monthly");
  assertEquals(envolMensuel.extraFilingsPerYear, 8);
  assertEquals(envolMensuel.annualCents, 20000);
  assertEquals(filingSupplement(terms.depart, "quarterly").extraFilingsPerYear, 3);
  assertEquals(filingSupplement(terms.elan, "annual").annualCents, 0);
  assertEquals(filingSupplement(terms.trajet, "annual").annualCents, 0);
});

Deno.test("suppléments : calculés avec les conditions accordées, pas la grille du jour", () => {
  // Client inscrit sous une ancienne grille : Départ avec 3 comptes, trimestrielle incluse, 12 $ le compte.
  const ancien = { ...terms.depart, includedAccounts: 3, includedFilingFrequency: "quarterly" as const, extraAccountCents: 1200 };
  assertEquals(extraAccounts(ancien, 3).monthlyCents, 0);
  assertEquals(extraAccounts(ancien, 4).monthlyCents, 1200);
  assertEquals(filingSupplement(ancien, "quarterly").annualCents, 0);
  assertEquals(addOnUnitPrice("extra_account", ancien), 1200);
});

Deno.test("suppléments : Sur mesure se règle par la soumission", () => {
  const surMesure = {
    planCode: "sur_mesure",
    includedAccounts: null,
    extraAccountCents: 0,
    includedFilingFrequency: null,
    extraFilingCents: 0,
  };
  assertEquals(assertThrows(() => extraAccounts(surMesure, 6), PricingError).code, "not_priced");
  assertEquals(assertThrows(() => filingSupplement(surMesure, "monthly"), PricingError).code, "not_priced");
});

Deno.test("TPS/TVQ seule : 75 $", () => {
  assertEquals(standaloneFilingPrice(), 7500);
});

Deno.test("comptes : 15 $ par mois au-delà des comptes inclus", () => {
  assertEquals(extraAccounts(terms.depart, 4), { includedAccounts: 2, extraAccounts: 2, unitMonthlyCents: 1500, monthlyCents: 3000 });
  assertEquals(extraAccounts(terms.envol, 5).monthlyCents, 0);
  assertEquals(extraAccounts(terms.trajet, 1).monthlyCents, 0);
  assertEquals(assertThrows(() => extraAccounts(terms.trajet, 2), PricingError).code, "not_eligible");
});

Deno.test("options : prix unitaires connus, factures clients sans prix fixe", () => {
  assertEquals(addOnUnitPrice("extra_account", terms.depart), 1500);
  assertEquals(addOnUnitPrice("more_frequent_filings", terms.depart), 2500);
  assertEquals(assertThrows(() => addOnUnitPrice("client_invoicing", terms.depart), PricingError).code, "not_priced");
});

Deno.test("accompagnement : 60 $/h par demi-heure entamée", () => {
  assertEquals(coachingCharge(20), { halfHours: 1, amountCents: 3000 });
  assertEquals(coachingCharge(30), { halfHours: 1, amountCents: 3000 });
  assertEquals(coachingCharge(31), { halfHours: 2, amountCents: 6000 });
  assertEquals(coachingCharge(90), { halfHours: 3, amountCents: 9000 });
  assertEquals(assertThrows(() => coachingCharge(0), PricingError).code, "invalid_input");
});

function suggested(n: number, billing: "monthly" | "annual" = "monthly"): string {
  const s = suggestPlan(n, billing);
  return s.kind === "plan" ? s.best.planCode : "sur_mesure";
}

Deno.test("simulateur : seuils en mensuel", () => {
  assertEquals(suggested(0), "depart");
  assertEquals(suggested(35), "depart"); // 79 $ + 15 × 4,50 $ = 146,50 $ < 149 $
  assertEquals(suggested(36), "elan"); // 151 $ > 149 $
  assertEquals(suggested(72), "elan"); // 248 $ < 249 $
  assertEquals(suggested(73), "envol");
  assertEquals(suggested(150), "envol");
  assertEquals(suggested(151), "sur_mesure");
});

Deno.test("simulateur : en annuel, le forfait compte pour 10/12", () => {
  assertEquals(suggested(32, "annual"), "depart");
  assertEquals(suggested(33, "annual"), "elan");
  const s = suggestPlan(10, "annual");
  if (s.kind !== "plan") throw new Error("forfait attendu");
  assertEquals(s.best.monthlyEstimateCents, 6583);
});

Deno.test("simulateur : comptes et déclarations en plus changent la suggestion", () => {
  // 30 transactions : Départ (79 + 45 = 124 $) est le moins cher...
  assertEquals(suggested(30), "depart");
  // ...mais avec 3 comptes (15 $) et des déclarations trimestrielles (3 × 25 $ ÷ 12 = 6,25 $),
  // Départ coûte 145,25 $ contre 149 $ pour Élan, qui les inclut.
  const s = suggestPlan(30, "monthly", { accounts: 3, filingFrequency: "quarterly" });
  if (s.kind !== "plan") throw new Error("forfait attendu");
  const depart = s.estimates[0];
  assertEquals([depart.extraAccountsCents, depart.extraFilingsCents, depart.monthlyEstimateCents], [1500, 625, 14525]);
  assertEquals(s.best.planCode, "depart");
  const s2 = suggestPlan(32, "monthly", { accounts: 3, filingFrequency: "quarterly" });
  if (s2.kind !== "plan") throw new Error("forfait attendu");
  assertEquals(s2.best.planCode, "elan"); // 154,25 $ > 149 $
});

Deno.test("simulateur : l'ouverture et QuickBooks sont donnés à part", () => {
  const s = suggestPlan(40);
  if (s.kind !== "plan") throw new Error("forfait attendu");
  assertEquals(s.best.planCode, "elan");
  assertEquals(s.best.openingFeeCents, 14900);
  assertEquals(s.best.quickbooksIncluded, false);
  assertEquals(s.estimates[0].quickbooksIncluded, true);
});

Deno.test("simulateur : ne suggère jamais Trajet", () => {
  const s = suggestPlan(5);
  if (s.kind !== "plan") throw new Error("forfait attendu");
  assertEquals(s.estimates.map((e) => e.planCode), ["depart", "elan", "envol"]);
});

Deno.test("Trajet : admissibilité et raisons d'un refus", () => {
  const ok = { platformIncomeOnly: true, accounts: 1, issuesClientInvoices: false, monthlyTransactions: 15 };
  assertEquals(trajetEligibility(ok), { eligible: true, reasons: [] });
  assertEquals(
    trajetEligibility({ platformIncomeOnly: false, accounts: 2, issuesClientInvoices: true, monthlyTransactions: 16 }).reasons,
    ["other_income", "too_many_accounts", "client_invoices", "too_many_transactions"],
  );
});
