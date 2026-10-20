import { assertEquals, assertThrows } from "./assert.ts";
import {
  type CurrentSubscription,
  planChangeDirection,
  PricingError,
  quoteDowngrade,
  quoteUpgrade,
  quoteWelcomeCallDowngrade,
} from "../../../_shared/domain/pricing/mod.ts";

/** Départ mensuel, inscrit en octobre avec le mois en cours payé. */
const departMonthly: CurrentSubscription = {
  planCode: "depart",
  billingOption: "monthly",
  recurringPriceCents: 7900,
  cycleStartsOn: "2026-10-01",
  collected: { openingFeeCents: 9900, currentCycleCents: 7900 },
};

/** Élan mensuel, mois en cours payé. */
const elanMonthly: CurrentSubscription = {
  planCode: "elan",
  billingOption: "monthly",
  recurringPriceCents: 14900,
  cycleStartsOn: "2026-10-01",
  collected: { openingFeeCents: 14900, currentCycleCents: 14900 },
};

/** Élan mensuel qui commence le mois suivant : seule l'ouverture est encaissée. */
const elanStartingNextMonth: CurrentSubscription = {
  ...elanMonthly,
  cycleStartsOn: "2026-11-01",
  collected: { openingFeeCents: 14900, currentCycleCents: 0 },
};

Deno.test("sens du changement", () => {
  assertEquals(planChangeDirection("trajet", "depart"), "upgrade");
  assertEquals(planChangeDirection("envol", "elan"), "downgrade");
  assertEquals(planChangeDirection("elan", "elan"), "same");
});

Deno.test("hausse : prorata des jours restants et différence d'ouverture", () => {
  const q = quoteUpgrade(departMonthly, "elan", "2026-10-20");
  assertEquals(q.effectiveFrom, "2026-10-20");
  assertEquals(q.remainingDays, 12); // du 20 au 31 octobre
  assertEquals(q.cycleDays, 31);
  assertEquals(q.prorataCents, 2710); // 70 $ × 12/31
  assertEquals(q.openingDifferenceCents, 5000); // 149 $ − 99 $ encaissés
  assertEquals(q.totalDueCents, 7710);
  assertEquals(q.newTerms.planCode, "elan");
  assertEquals(q.newTerms.recurringPriceCents, 14900);
});

Deno.test("hausse : le 1er du mois, tout le mois est dû", () => {
  assertEquals(quoteUpgrade(departMonthly, "elan", "2026-10-01").prorataCents, 7000);
});

Deno.test("hausse avec engagement : ouvertures à moitié prix", () => {
  const q = quoteUpgrade(
    { ...departMonthly, billingOption: "monthly_commitment", collected: { openingFeeCents: 4900, currentCycleCents: 7900 } },
    "elan",
    "2026-10-20",
  );
  assertEquals(q.openingDifferenceCents, 2600); // 75 $ − 49 $
  assertEquals(q.newTerms.billingOption, "monthly_commitment");
});

Deno.test("hausse annuelle : prorata sur l'année payée", () => {
  const q = quoteUpgrade(
    {
      planCode: "depart",
      billingOption: "annual",
      recurringPriceCents: 79000,
      cycleStartsOn: "2026-01-01",
      collected: { openingFeeCents: 4900, currentCycleCents: 79000 },
    },
    "envol",
    "2026-10-20",
  );
  assertEquals(q.cycleDays, 365);
  assertEquals(q.remainingDays, 73);
  assertEquals(q.prorataCents, 34000); // 1 700 $ × 73/365
  assertEquals(q.openingDifferenceCents, 5000); // 99 $ − 49 $
});

Deno.test("hausse avant le premier cycle : seulement la différence d'ouverture", () => {
  const depart = { ...elanStartingNextMonth, planCode: "depart" as const, recurringPriceCents: 7900, collected: { openingFeeCents: 9900, currentCycleCents: 0 } };
  const q = quoteUpgrade(depart, "elan", "2026-10-22");
  assertEquals(q.effectiveFrom, "2026-11-01");
  assertEquals(q.prorataCents, 0);
  assertEquals(q.totalDueCents, 5000);
});

Deno.test("Trajet non admissible : passage à Départ avec les différences", () => {
  const q = quoteUpgrade(
    {
      planCode: "trajet",
      billingOption: "monthly",
      recurringPriceCents: 4900,
      cycleStartsOn: "2026-10-01",
      collected: { openingFeeCents: 4900, currentCycleCents: 4900 },
    },
    "depart",
    "2026-10-01",
  );
  assertEquals(q.prorataCents, 3000);
  assertEquals(q.openingDifferenceCents, 5000);
});

Deno.test("hausse : le prix accordé d'une ancienne grille sert de point de départ", () => {
  assertEquals(quoteUpgrade({ ...departMonthly, recurringPriceCents: 4900 }, "elan", "2026-10-01").prorataCents, 10000);
});

Deno.test("hausse : refus si ce n'est pas une hausse ou hors du cycle", () => {
  assertEquals(assertThrows(() => quoteUpgrade(departMonthly, "trajet", "2026-10-20"), PricingError).code, "not_an_upgrade");
  assertEquals(assertThrows(() => quoteUpgrade(departMonthly, "depart", "2026-10-20"), PricingError).code, "same_plan");
  assertEquals(assertThrows(() => quoteUpgrade(departMonthly, "elan", "2026-11-01"), PricingError).code, "invalid_input");
});

Deno.test("baisse : au début du mois suivant, sans remboursement", () => {
  const q = quoteDowngrade(elanMonthly, "depart", "2026-10-20");
  assertEquals(q.effectiveFrom, "2026-11-01");
  assertEquals(q.refundCents, 0);
  assertEquals(q.newTerms.recurringPriceCents, 7900);
});

Deno.test("baisse avant le premier cycle : dès son début", () => {
  assertEquals(quoteDowngrade(elanStartingNextMonth, "depart", "2026-10-22").effectiveFrom, "2026-11-01");
});

Deno.test("baisse annuelle : à la fin de l'année payée", () => {
  const q = quoteDowngrade(
    {
      planCode: "envol",
      billingOption: "annual",
      recurringPriceCents: 249000,
      cycleStartsOn: "2026-03-01",
      collected: { openingFeeCents: 9900, currentCycleCents: 249000 },
    },
    "elan",
    "2026-10-20",
  );
  assertEquals(q.effectiveFrom, "2027-03-01");
});

Deno.test("baisse vers Trajet : impossible avec un engagement", () => {
  const err = assertThrows(
    () => quoteDowngrade({ ...departMonthly, billingOption: "monthly_commitment" }, "trajet", "2026-10-20"),
    PricingError,
  );
  assertEquals(err.code, "billing_not_offered");
});

Deno.test("appel de bienvenue : remboursement des sommes encaissées", () => {
  const q = quoteWelcomeCallDowngrade(elanMonthly, "depart", "2026-10-22", false);
  assertEquals(q.effectiveFrom, "2026-10-22");
  assertEquals(q.cycleRefundCents, 7000);
  assertEquals(q.openingRefundCents, 5000);
  assertEquals(q.refundCents, 12000);
});

Deno.test("appel de bienvenue : cycle pas encore payé, seule l'ouverture est remboursée", () => {
  // Cas signalé à la revue : Élan qui commence le mois suivant, 149 $ encaissés.
  const q = quoteWelcomeCallDowngrade(elanStartingNextMonth, "depart", "2026-10-22", false);
  assertEquals(q.cycleRefundCents, 0);
  assertEquals(q.openingRefundCents, 5000);
  assertEquals(q.refundCents, 5000);
  assertEquals(q.effectiveFrom, "2026-11-01");
});

Deno.test("appel de bienvenue : paiement du mois en échec, rien à rembourser sur le cycle", () => {
  const q = quoteWelcomeCallDowngrade(
    { ...elanMonthly, collected: { openingFeeCents: 14900, currentCycleCents: 0 } },
    "depart",
    "2026-10-22",
    false,
  );
  assertEquals(q.refundCents, 5000);
});

Deno.test("appel de bienvenue, client annuel", () => {
  const q = quoteWelcomeCallDowngrade(
    {
      planCode: "elan",
      billingOption: "annual",
      recurringPriceCents: 149000,
      cycleStartsOn: "2026-10-01",
      collected: { openingFeeCents: 7500, currentCycleCents: 149000 },
    },
    "depart",
    "2026-10-22",
    false,
  );
  assertEquals(q.refundCents, 70000 + 2600);
});

Deno.test("appel de bienvenue : refusé si le travail a commencé", () => {
  const err = assertThrows(() => quoteWelcomeCallDowngrade(elanMonthly, "depart", "2026-10-22", true), PricingError);
  assertEquals(err.code, "work_started");
});
