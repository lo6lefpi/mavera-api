import { StripeGateway } from '../_shared/integrations/stripe/gateway.ts';
import { SupabaseCheckoutRepository, SupabaseRateLimiter } from '../_shared/integrations/supabase/repository.ts';
import { type HumanCheck, TurnstileVerifier } from '../_shared/integrations/turnstile/verify.ts';
import { handlePublicApi, montrealToday } from './handler.ts';

const allowedOrigins = [Deno.env.get('PUBLIC_SITE_ORIGIN'), Deno.env.get('PUBLIC_PORTAL_ORIGIN')]
  .filter((origin): origin is string => Boolean(origin));

/**
 * Antirobot obligatoire : sans TURNSTILE_SECRET_KEY, /checkout est indisponible,
 * sauf si CAPTCHA_DISABLED=true (développement local seulement).
 */
function humanCheck(): HumanCheck | null {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  if (secret) {
    const hostnames = allowedOrigins.map(origin => new URL(origin).hostname);
    return new TurnstileVerifier(secret, hostnames);
  }
  if (Deno.env.get('CAPTCHA_DISABLED') === 'true') return null;
  return { verify: () => Promise.reject(new Error('TURNSTILE_SECRET_KEY manquante')) };
}

const check = humanCheck();

Deno.serve(request => handlePublicApi(request, {
  allowedOrigins,
  humanCheck: check,
  today: () => montrealToday(),
  rateLimiter: () => new SupabaseRateLimiter(),
  checkoutDeps: () => ({ billing: new StripeGateway(), repository: new SupabaseCheckoutRepository() }),
}));
