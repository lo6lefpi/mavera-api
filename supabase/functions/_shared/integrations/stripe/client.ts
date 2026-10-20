/**
 * Client Stripe. Seul ce dossier importe le SDK (un test le vérifie).
 * Version du SDK et version de l'API épinglées ensemble : la version d'API
 * est celle livrée avec ce SDK. Changer l'une oblige à revalider l'autre.
 */
import Stripe from 'npm:stripe@22.6.0';

export const STRIPE_API_VERSION = '2026-08-26.dahlia';

let singleton: Stripe | undefined;

export function stripeClient(): Stripe {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY manquante');
  return singleton ??= new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
}

/**
 * Instance réservée à la vérification des signatures : n'appelle jamais
 * l'API, donc n'a pas besoin de la clé secrète.
 */
let verifier: Stripe | undefined;
export function signatureVerifier(): Stripe {
  return verifier ??= new Stripe('sk_signature_only', {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export { Stripe };
