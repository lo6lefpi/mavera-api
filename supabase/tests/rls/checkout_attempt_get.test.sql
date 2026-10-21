-- Lecture d'une tentative par les Edge Functions : service_role seulement.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

select plan(5);

select public.checkout_attempt_create('a1111111-1111-4111-8111-111111111111', 'elise@exemple.ca',
  '514 555 0101', 'Élise Conseil', true, false, 40, '{"terms":{"gridVersion":"2026-10","planCode":"elan","billingOption":"monthly_commitment","cycle":"month","recurringPriceCents":14900,"includedTransactions":50,"extraTransactionCents":450,"includedAccounts":3,"extraAccountCents":1500,"includedFilingFrequency":"quarterly","extraFilingCents":2500,"quickbooksIncluded":false,"openingFeeCents":7500,"openingDiscountCents":7400,"stripeRecurringLookupKey":"elan_monthly_2026_10"},"startsOn":"2026-10-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":7500,"gstCents":375,"qstCents":748},{"kind":"first_period","amountCents":14900,"gstCents":745,"qstCents":1486}],"subtotalCents":22400,"gstCents":1120,"qstCents":2234,"totalCents":25754},"recurring":{"amountCents":14900,"gstCents":745,"qstCents":1486,"totalCents":17131,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":"2027-10-01","extraTransactionCents":450,"currentMonthBooksUpdate":null,"taxRegion":"QC"}'::jsonb);

select ok(not has_function_privilege('anon', 'public.checkout_attempt_get(uuid)', 'execute'), 'Visiteur : aucun accès');
select ok(not has_function_privilege('authenticated', 'public.checkout_attempt_get(uuid)', 'execute'), 'Client connecté : aucun accès');
select ok(has_function_privilege('service_role', 'public.checkout_attempt_get(uuid)', 'execute'), 'Edge Functions : accès');

set local role service_role;
select is((select email from public.checkout_attempt_get('a1111111-1111-4111-8111-111111111111')), 'elise@exemple.ca', 'Tentative retrouvée');
select is((select count(*)::integer from public.checkout_attempt_get('a0000000-0000-4000-8000-000000000000')), 0, 'Tentative inconnue : aucune ligne');
reset role;

select * from finish();
rollback;
