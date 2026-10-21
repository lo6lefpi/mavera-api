import { assertEquals } from "./assert.ts";
import {
  BOOKS_UPDATE,
  COACHING,
  EXTRA_ACCOUNT_MONTHLY_CENTS,
  EXTRA_FILING_CENTS,
  EXTRA_TRANSACTION_CENTS,
  grantTerms,
  hasHalfCentTax,
  PLANS,
  quebecTaxes,
  STANDALONE_FILING_CENTS,
} from "../../../_shared/domain/pricing/mod.ts";

Deno.test("taxes : TPS 5 % et TVQ 9,975 % sur le montant avant taxes", () => {
  assertEquals(quebecTaxes(10000), { amountCents: 10000, gstCents: 500, qstCents: 998, totalCents: 11498 });
  assertEquals(quebecTaxes(7900), { amountCents: 7900, gstCents: 395, qstCents: 788, totalCents: 9083 });
  assertEquals(quebecTaxes(0), { amountCents: 0, gstCents: 0, qstCents: 0, totalCents: 0 });
});

Deno.test("taxes : arrondi au cent, la moitié vers le haut", () => {
  // 20 $ : TVQ 1,995 $ → 2,00 $ (pile un demi-cent)
  assertEquals(quebecTaxes(2000).qstCents, 200);
  assertEquals(hasHalfCentTax(2000), true);
  // 1 cent : TPS 0,05 ¢ → 0; TVQ 0,09975 ¢ → 0
  assertEquals(quebecTaxes(1), { amountCents: 1, gstCents: 0, qstCents: 0, totalCents: 1 });
});

Deno.test("taxes : aucun montant de l'inscription ne tombe sur un demi-cent (même résultat que Stripe)", () => {
  const amounts = new Set<number>();
  for (const plan of Object.values(PLANS)) {
    for (const option of plan.billingOptions) {
      const t = grantTerms(plan.code, option);
      amounts.add(t.recurringPriceCents);
      amounts.add(t.openingFeeCents);
    }
  }
  assertEquals([...amounts].filter(hasHalfCentTax), []);
});

Deno.test("taxes : montants à demi-cent connus, hors inscription", () => {
  // Pour ces montants, l'arrondi dépend de la règle : quand ils seront facturés
  // (factures du mois), la taxe calculée par Stripe fait foi et doit être relue,
  // jamais recalculée ici. Ce test signale tout nouveau cas.
  const ties = [EXTRA_TRANSACTION_CENTS, EXTRA_ACCOUNT_MONTHLY_CENTS, EXTRA_FILING_CENTS,
    STANDALONE_FILING_CENTS, BOOKS_UPDATE.minimumCents, BOOKS_UPDATE.perTransactionCents, COACHING.hourlyCents]
    .filter(hasHalfCentTax);
  assertEquals(ties, [EXTRA_TRANSACTION_CENTS, COACHING.hourlyCents]); // 4,50 $ (TPS 22,5 ¢) et 60 $ (TVQ 598,5 ¢)
});
