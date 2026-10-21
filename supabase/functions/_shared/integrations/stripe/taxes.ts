import { QUEBEC_TAXES, type TaxCode } from '../../domain/pricing/mod.ts';
import type { Stripe } from './client.ts';

/**
 * Taux de taxe fixes chez Stripe (gratuits, sans Stripe Tax) : TPS et TVQ,
 * créés une fois par scripts/stripe-sandbox-setup.ts. Retrouvés par leur
 * code (metadata.tax_code) et vérifiés contre domain/pricing : un écart
 * bloque l'inscription au lieu de facturer une autre taxe.
 */
let cache: Record<TaxCode, string> | undefined;

export const TAX_RATE_SPECS = {
  gst: { display_name: 'TPS', tax_type: 'gst' },
  qst: { display_name: 'TVQ', tax_type: 'qst' },
} as const;

export function matchesDomain(rate: Stripe.TaxRate, code: TaxCode): boolean {
  return rate.active && !rate.inclusive && rate.percentage === QUEBEC_TAXES[code].percent &&
    rate.country === 'CA' && rate.state === 'QC' && rate.tax_type === TAX_RATE_SPECS[code].tax_type;
}

export async function quebecTaxRateIds(stripe: Stripe): Promise<string[]> {
  if (!cache) {
    const found: Partial<Record<TaxCode, Stripe.TaxRate[]>> = {};
    for await (const rate of stripe.taxRates.list({ active: true, limit: 100 })) {
      const code = rate.metadata?.tax_code as TaxCode | undefined;
      if (code === 'gst' || code === 'qst') (found[code] ??= []).push(rate);
    }
    const pick = (code: TaxCode): string => {
      const rates = found[code] ?? [];
      if (rates.length !== 1) throw new Error(`Taux Stripe ${TAX_RATE_SPECS[code].display_name} introuvable ou ambigu`);
      if (!matchesDomain(rates[0], code)) {
        throw new Error(`Écart entre domain/pricing et Stripe pour ${TAX_RATE_SPECS[code].display_name}`);
      }
      return rates[0].id;
    };
    cache = { gst: pick('gst'), qst: pick('qst') };
  }
  return [cache.gst, cache.qst];
}
