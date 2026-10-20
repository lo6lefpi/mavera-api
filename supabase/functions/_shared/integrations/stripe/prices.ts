import type { Stripe } from './client.ts';

/** Gardé en mémoire le temps de vie de l'instance de la fonction. */
const cache = new Map<string, Stripe.Price>();

/**
 * Prix d'abonnement retrouvé par sa clé de recherche (ex. depart_monthly_2026_10).
 * Il doit correspondre exactement aux conditions accordées au client : un écart
 * entre domain/pricing et Stripe bloque l'inscription au lieu de facturer un
 * autre montant.
 */
export async function resolveRecurringPrice(
  stripe: Stripe, lookupKey: string, expectedCents: number, cycle: 'month' | 'year',
): Promise<Stripe.Price> {
  let price = cache.get(lookupKey);
  if (!price) {
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 10 });
    if (found.data.length !== 1) throw new Error(`Prix Stripe introuvable ou ambigu : ${lookupKey}`);
    price = found.data[0];
    cache.set(lookupKey, price);
  }
  if (price.currency !== 'cad' || price.type !== 'recurring' || price.unit_amount !== expectedCents ||
      price.recurring?.interval !== cycle || price.recurring?.interval_count !== 1) {
    throw new Error(`Écart entre domain/pricing et Stripe pour ${lookupKey}`);
  }
  return price;
}

export function productIdOf(price: Stripe.Price): string {
  return typeof price.product === 'string' ? price.product : price.product.id;
}
