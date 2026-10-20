import { assertEquals } from "./assert.ts";
import { grantTerms } from "../../../_shared/domain/pricing/mod.ts";

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
