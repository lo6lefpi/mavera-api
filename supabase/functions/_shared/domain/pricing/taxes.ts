/**
 * Taxes de vente du Québec : TPS 5 % et TVQ 9,975 %, toutes deux calculées
 * sur le montant avant taxes (la TVQ ne s'applique pas sur la TPS).
 *
 * Clients au Québec seulement (décision du 20 octobre 2026). Un client d'une
 * autre province demanderait d'autres taxes (TVH, etc.) : à revoir avant
 * d'en accepter.
 *
 * Chaque taxe est calculée par montant facturé (ligne), puis arrondie au cent
 * le plus proche, la moitié vers le haut : c'est aussi ce que fait Stripe avec
 * des taux fixes, ligne par ligne. Les montants de la grille ne tombent jamais
 * pile sur un demi-cent (un test le vérifie) : le mode d'arrondi n'y change rien.
 */
import { assertCents, type Cents, prorate } from "./money.ts";

export const TAX_REGION = "QC" as const;

/** Taux en cent-millièmes : 5000 = 5 %, 9975 = 9,975 %. */
export const QUEBEC_TAXES = {
  gst: { label: "TPS", ratePer100k: 5000, percent: 5 },
  qst: { label: "TVQ", ratePer100k: 9975, percent: 9.975 },
} as const;

export type TaxCode = keyof typeof QUEBEC_TAXES;

export interface TaxedAmount {
  /** Montant avant taxes. */
  readonly amountCents: Cents;
  readonly gstCents: Cents;
  readonly qstCents: Cents;
  /** Montant taxes comprises. */
  readonly totalCents: Cents;
}

export function quebecTaxes(amountCents: Cents): TaxedAmount {
  assertCents(amountCents, "amountCents");
  const gstCents = prorate(amountCents, QUEBEC_TAXES.gst.ratePer100k, 100_000);
  const qstCents = prorate(amountCents, QUEBEC_TAXES.qst.ratePer100k, 100_000);
  return { amountCents, gstCents, qstCents, totalCents: amountCents + gstCents + qstCents };
}

/** Vrai si une taxe tombe pile sur un demi-cent : l'arrondi dépendrait alors de la règle. */
export function hasHalfCentTax(amountCents: Cents): boolean {
  return Object.values(QUEBEC_TAXES).some(t => (amountCents * t.ratePer100k) % 100_000 === 50_000);
}
