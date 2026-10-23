-- Une nouvelle grille accepte toujours les récapitulatifs et conditions déjà accordés.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(7);
create temp table q (k text primary key, v jsonb) on commit drop;
insert into q values
  ('legacy', '{"terms":{"gridVersion":"2026-10","planCode":"trajet","billingOption":"monthly","cycle":"month","recurringPriceCents":4900,"includedTransactions":15,"extraTransactionCents":450,"includedAccounts":1,"extraAccountCents":1500,"includedFilingFrequency":"annual","extraFilingCents":2500,"quickbooksIncluded":true,"openingFeeCents":4900,"openingDiscountCents":0,"stripeRecurringLookupKey":"trajet_monthly_2026_10"},"startsOn":"2026-11-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":4900,"gstCents":245,"qstCents":489}],"subtotalCents":4900,"gstCents":245,"qstCents":489,"totalCents":5634},"recurring":{"amountCents":4900,"gstCents":245,"qstCents":489,"totalCents":5634,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":null,"extraTransactionCents":450,"currentMonthBooksUpdate":{"fromCents":12000,"month":"2026-10-01"},"taxRegion":"QC"}'),
  ('current', '{"terms":{"gridVersion":"2026-10-21","planCode":"trajet","billingOption":"monthly","cycle":"month","recurringPriceCents":5900,"includedTransactions":20,"extraTransactionCents":450,"includedAccounts":2,"extraAccountCents":1500,"includedFilingFrequency":"annual","extraFilingCents":2500,"quickbooksIncluded":true,"openingFeeCents":5900,"openingDiscountCents":0,"stripeRecurringLookupKey":"trajet_monthly_2026_10_21"},"startsOn":"2026-11-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":5900,"gstCents":295,"qstCents":589}],"subtotalCents":5900,"gstCents":295,"qstCents":589,"totalCents":6784},"recurring":{"amountCents":5900,"gstCents":295,"qstCents":589,"totalCents":6784,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":null,"extraTransactionCents":450,"currentMonthBooksUpdate":{"fromCents":12000,"month":"2026-10-01"},"taxRegion":"QC"}');
select ok(private.is_valid_checkout_quote((select v from q where k = 'legacy')), 'Ancienne grille mensuelle toujours valide');
select ok(private.is_valid_checkout_quote((select v from q where k = 'current')), 'Nouvelle grille datée valide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{terms,gridVersion}', '"invalide"') from q where k = 'current')), 'Version mal formée refusée');
select lives_ok($$ select public.checkout_attempt_create('d1111111-1111-4111-8111-111111111111', 'legacy-grid@exemple.ca',
  '5145550197', 'Ancien Trajet', true, false, 12, (select v from q where k = 'legacy')) $$, 'Ancienne offre enregistrée sans recalcul');
select public.checkout_attempt_save_session('d1111111-1111-4111-8111-111111111111', 'cs_legacy_grid');
select ok(public.checkout_attempt_claim('d1111111-1111-4111-8111-111111111111', 'd2222222-2222-4222-8222-222222222222'), 'Verrou acquis');
select public.checkout_attempt_paid('d1111111-1111-4111-8111-111111111111', 'd2222222-2222-4222-8222-222222222222',
  'cs_legacy_grid', 'cus_legacy_grid', 'pi_legacy_grid', 'pm_legacy_grid', 5634);
select public.checkout_attempt_subscription('d1111111-1111-4111-8111-111111111111', 'd2222222-2222-4222-8222-222222222222',
  'sub_legacy_grid', 'price_trajet_monthly_2026_10', 'active');
select lives_ok($$ select public.checkout_attempt_finish('d1111111-1111-4111-8111-111111111111',
  'd2222222-2222-4222-8222-222222222222', 'evt_legacy_grid', now() + interval '7 days') $$, 'Paiement de l’ancienne offre finalisé');
select is((select pp.recurring_price_cents || '/' || pp.included_transactions || '/' || pp.included_accounts || '/' ||
                  pp.grid_version || '/' || s.opening_fee_cents || '/' || pp.stripe_price_id
  from public.subscription_plan_periods pp join public.subscriptions s on s.id = pp.subscription_id
  where s.stripe_subscription_id = 'sub_legacy_grid'),
  '4900/15/1/2026-10/4900/price_trajet_monthly_2026_10', 'Ancien prix, quotas, ouverture et clé Stripe conservés');
select * from finish();
rollback;
