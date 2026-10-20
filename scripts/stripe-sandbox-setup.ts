/**
 * Crée les prix d'abonnement dans le BAC À SABLE Stripe, à partir de domain/pricing.
 * Aucun montant n'est recopié à la main : la grille est la seule source.
 *
 *   deno run --allow-env --allow-net --env-file=supabase/functions/.env scripts/stripe-sandbox-setup.ts
 *   (ajouter --dry-run pour seulement afficher ce qui serait créé)
 *
 * Sans danger à relancer : un prix déjà présent et identique est gardé. Un prix
 * présent mais différent arrête le script : changer un prix demande une nouvelle
 * version de la grille (GRID_VERSION), jamais une modification en place.
 */
import { stripeClient, type Stripe } from '../supabase/functions/_shared/integrations/stripe/client.ts';
import {
  type BillingOption,
  GRID_VERSION,
  grantTerms,
  PLANS,
} from '../supabase/functions/_shared/domain/pricing/mod.ts';

export interface ExpectedPrice {
  lookupKey: string;
  planCode: string;
  planName: string;
  amountCents: number;
  interval: 'month' | 'year';
}

/** Un prix par clé de recherche : le mensuel avec engagement partage le prix du mensuel. */
export function expectedRecurringPrices(): ExpectedPrice[] {
  const byKey = new Map<string, ExpectedPrice>();
  for (const plan of Object.values(PLANS)) {
    for (const option of plan.billingOptions as readonly BillingOption[]) {
      const t = grantTerms(plan.code, option);
      const price = {
        lookupKey: t.stripeRecurringLookupKey, planCode: plan.code, planName: plan.name,
        amountCents: t.recurringPriceCents, interval: t.cycle,
      };
      const seen = byKey.get(price.lookupKey);
      if (seen && (seen.amountCents !== price.amountCents || seen.interval !== price.interval)) {
        throw new Error(`Deux montants pour la même clé : ${price.lookupKey}`);
      }
      byKey.set(price.lookupKey, price);
    }
  }
  return [...byKey.values()];
}

async function findProduct(stripe: Stripe, planCode: string): Promise<Stripe.Product | null> {
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.metadata?.pricing_plan === planCode && product.metadata?.grid_version === GRID_VERSION) return product;
  }
  return null;
}

async function main() {
  const key = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  if (!key.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY doit être une clé de bac à sable (sk_test_…) : aucune clé de production.');
  }
  const dryRun = Deno.args.includes('--dry-run');
  const stripe = stripeClient();
  const prices = expectedRecurringPrices();
  console.log(`Grille ${GRID_VERSION} : ${prices.length} prix d'abonnement${dryRun ? ' (simulation)' : ''}\n`);

  for (const p of prices) {
    const label = `${p.lookupKey.padEnd(24)} ${(p.amountCents / 100).toFixed(2).padStart(8)} $ / ${p.interval === 'year' ? 'an' : 'mois'}`;
    const found = await stripe.prices.list({ lookup_keys: [p.lookupKey], limit: 10 });
    if (found.data.length > 1) throw new Error(`Plusieurs prix pour ${p.lookupKey} : à corriger dans Stripe`);
    const existing = found.data[0];
    if (existing) {
      const same = existing.active && existing.currency === 'cad' && existing.type === 'recurring' &&
        existing.unit_amount === p.amountCents && existing.recurring?.interval === p.interval &&
        existing.recurring?.interval_count === 1;
      if (!same) {
        throw new Error(`${p.lookupKey} existe chez Stripe avec d'autres conditions (${existing.id}). ` +
          'Ne pas modifier un prix : créer une nouvelle version de la grille.');
      }
      console.log(`  ✓ ${label}   déjà présent (${existing.id})`);
      continue;
    }
    if (dryRun) { console.log(`  + ${label}   à créer`); continue; }

    const product = await findProduct(stripe, p.planCode) ?? await stripe.products.create({
      name: `Tenue de livres — ${p.planName}`,
      metadata: { pricing_plan: p.planCode, grid_version: GRID_VERSION },
    }, { idempotencyKey: `setup:product:${GRID_VERSION}:${p.planCode}` });
    const created = await stripe.prices.create({
      currency: 'cad', product: product.id, unit_amount: p.amountCents,
      recurring: { interval: p.interval, interval_count: 1 },
      tax_behavior: 'exclusive',
      lookup_key: p.lookupKey,
      metadata: { pricing_plan: p.planCode, grid_version: GRID_VERSION },
    }, { idempotencyKey: `setup:price:${p.lookupKey}` });
    console.log(`  + ${label}   créé (${created.id})`);
  }
  console.log('\nTerminé. Les montants sont avant taxes (tax_behavior: exclusive).');
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`\nÉchec : ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}
