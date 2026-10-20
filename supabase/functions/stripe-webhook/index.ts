import { StripeGateway } from '../_shared/integrations/stripe/gateway.ts';
import { SupabaseCheckoutRepository } from '../_shared/integrations/supabase/repository.ts';
import { handleStripeWebhook } from './handler.ts';

Deno.serve(request => handleStripeWebhook(request, {
  services: () => ({ billing: new StripeGateway(), repository: new SupabaseCheckoutRepository() }),
}));
