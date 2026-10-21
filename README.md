# mavera-api

## Paiements : test de bout en bout (bac à sable Stripe)

Jamais de clé de production : les scripts refusent toute clé qui ne commence pas par `sk_test_`.

1. Copier `supabase/functions/.env.example` en `supabase/functions/.env` et remplir
   `STRIPE_SECRET_KEY` (bac à sable), `PUBLIC_SITE_ORIGIN`, et `CAPTCHA_DISABLED=true` en local.
2. Créer les prix d'abonnement et les taux de TPS et de TVQ (une seule fois par grille; sans danger à relancer) :
   `deno run --allow-env --allow-net --env-file=supabase/functions/.env scripts/stripe-sandbox-setup.ts`
3. Trois terminaux :
   - `supabase start` puis `supabase functions serve`
   - `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook`
     (copier le `whsec_…` affiché dans `STRIPE_WEBHOOK_SECRET`, puis relancer `functions serve`)
   - `deno run -A --env-file=supabase/functions/.env scripts/e2e-checkout.ts depart monthly current`
4. Payer sur la page affichée avec la carte `4242 4242 4242 4242`. Le script vérifie Stripe,
   la base, puis rejoue l'événement pour confirmer qu'aucun deuxième dossier n'est créé.
