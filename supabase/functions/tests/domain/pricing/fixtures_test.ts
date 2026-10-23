import { assertEquals } from "./assert.ts";
import { grantTerms, quoteCheckout } from "../../../_shared/domain/pricing/mod.ts";

/**
 * Garde-fou en attendant le test d'intégration de stripe-webhook : les
 * conditions passées à handle_checkout_completed dans les tests SQL doivent
 * être exactement celles que grantTerms() produit pour le même forfait et la
 * même facturation. Sinon, ces tests pourraient cacher une mauvaise
 * transmission des conditions entre le domaine et la base.
 */
const FIXTURE =
  /'(trajet|depart|elan|envol)',\s*'(monthly|monthly_commitment|annual)',[^\n]*\n[^\n]*\n\s*(\d+), (\d+), (\d+), (\d+), '([^']+)', (\d+), '([^']+)', (\d+), '(\w+)', (true|false), (\d+), (\d+)/g;

Deno.test("tests SQL : les conditions de handle_checkout_completed suivent grantTerms()", async () => {
  const dir = new URL("../../../../tests/rls/", import.meta.url);
  let found = 0;
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".sql")) continue;
    const sql = await Deno.readTextFile(new URL(entry.name, dir));
    for (const m of sql.matchAll(FIXTURE)) {
      found++;
      const t = grantTerms(m[1], m[2]);
      assertEquals(
        m.slice(3).join("|"),
        [
          t.recurringPriceCents,
          t.includedTransactions,
          t.extraTransactionCents,
          t.openingFeeCents,
          t.stripeRecurringLookupKey,
          t.openingDiscountCents,
          t.gridVersion,
          t.includedAccounts,
          t.includedFilingFrequency,
          t.quickbooksIncluded,
          t.extraAccountCents,
          t.extraFilingCents,
        ].join("|"),
        `${entry.name} : ${m[1]} / ${m[2]}`,
      );
    }
  }
  assertEquals(found >= 9, true, `seulement ${found} appels trouvés : le format des tests SQL a changé ?`);
});

/**
 * Même garde-fou pour les récapitulatifs enregistrés dans checkout_attempts :
 * chaque JSON de checkout_attempts.test.sql doit être exactement la sortie de
 * quoteCheckout() du 20 octobre 2026 pour le même choix.
 */
const QUOTE = /\('(\w+)',\s*'(\{"terms".*?\})'\)/g;
const QUOTE_DAY = "2026-10-20";
const DRIVER = { platformIncomeOnly: true, accounts: 1, issuesClientInvoices: false };

Deno.test("tests SQL : les récapitulatifs de checkout_attempts suivent quoteCheckout()", async () => {
  const sql = await Deno.readTextFile(new URL("../../../../tests/rls/checkout_attempts.test.sql", import.meta.url));
  let found = 0;
  for (const m of sql.matchAll(QUOTE)) {
    found++;
    const stored = JSON.parse(m[2]);
    const expected = quoteCheckout({
      planCode: stored.terms.planCode,
      billingOption: stored.terms.billingOption,
      startMonth: stored.startsOn === "2026-10-01" ? "current" : "next",
      today: QUOTE_DAY,
      trajetProfile: DRIVER,
    });
    assertEquals(stored, JSON.parse(JSON.stringify(expected)), m[1]);
  }
  assertEquals(found >= 2, true, `seulement ${found} récapitulatifs trouvés`);
});
