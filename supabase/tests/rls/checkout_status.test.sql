-- Lecture du retour Stripe : privilèges, session exacte, preuve du dossier et aucun effet de bord.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

select plan(20);

select ok(not has_function_privilege('anon', 'public.checkout_attempt_status_by_session(text)', 'execute'), 'Visiteur : RPC inaccessible');
select ok(not has_function_privilege('authenticated', 'public.checkout_attempt_status_by_session(text)', 'execute'), 'Client connecté : RPC inaccessible');
select ok(has_function_privilege('service_role', 'public.checkout_attempt_status_by_session(text)', 'execute'), 'Edge Function : RPC accessible');
set local role anon;
select throws_ok($$ select * from public.checkout_attempt_status_by_session('cs_test_status') $$,
  '42501', null, 'Visiteur : exécution refusée');
reset role;
set local role authenticated;
select throws_ok($$ select * from public.checkout_attempt_status_by_session('cs_test_status') $$,
  '42501', null, 'Client connecté : exécution refusée');
reset role;

select public.checkout_attempt_create('a1111111-1111-4111-8111-111111111111', 'status@exemple.ca',
  '514 555 0101', 'Nom confidentiel', true, false, 40,
  '{"terms":{"gridVersion":"2026-10-21","planCode":"elan","billingOption":"monthly_commitment","cycle":"month","recurringPriceCents":14900,"includedTransactions":50,"extraTransactionCents":450,"includedAccounts":3,"extraAccountCents":1500,"includedFilingFrequency":"quarterly","extraFilingCents":2500,"quickbooksIncluded":false,"openingFeeCents":7500,"openingDiscountCents":7400,"stripeRecurringLookupKey":"elan_monthly_2026_10_21"},"startsOn":"2026-10-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":7500,"gstCents":375,"qstCents":748},{"kind":"first_period","amountCents":14900,"gstCents":745,"qstCents":1486}],"subtotalCents":22400,"gstCents":1120,"qstCents":2234,"totalCents":25754},"recurring":{"amountCents":14900,"gstCents":745,"qstCents":1486,"totalCents":17131,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":"2027-10-01","extraTransactionCents":450,"currentMonthBooksUpdate":null,"taxRegion":"QC"}'::jsonb);
select public.checkout_attempt_save_session('a1111111-1111-4111-8111-111111111111', 'cs_test_status');

set local role service_role;
select is((select count(*)::integer from public.checkout_attempt_status_by_session('cs_test_unknown')), 0, 'Session inconnue : aucune ligne');
select is((select id from public.checkout_attempt_status_by_session('cs_test_status')), 'a1111111-1111-4111-8111-111111111111'::uuid, 'Session exacte : tentative retrouvée');
select is((select count(*)::integer from public.checkout_attempt_status_by_session('cs_test_stat')), 0, 'Préfixe seulement : aucune ligne');
select is((select count(*)::integer from public.checkout_attempt_status_by_session('CS_TEST_STATUS')), 0, 'Casse différente : aucune ligne');
select is((select count(*)::integer from public.checkout_attempt_status_by_session(null)), 0, 'Session nulle : aucune ligne');
select is((select granted_quote #>> '{dueToday,totalCents}' from public.checkout_attempt_status_by_session('cs_test_status')), '25754', 'Montant du jour accordé, TPS et TVQ incluses');
select is((select granted_quote #>> '{recurring,totalCents}' from public.checkout_attempt_status_by_session('cs_test_status')), '17131', 'Prochain montant accordé, TPS et TVQ incluses');
select ok((select not (to_jsonb(s) ?| array['email', 'phone', 'display_name', 'rejection_reason'])
  from public.checkout_attempt_status_by_session('cs_test_status') s), 'Port de lecture sans coordonnées ni motif');
select is((select dossier_exists from public.checkout_attempt_status_by_session('cs_test_status')), false, 'Non payée : aucun dossier');
reset role;

select public.checkout_attempt_claim('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111');
select public.checkout_attempt_paid('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111',
  'cs_test_status', 'cus_status', 'pi_status', 'pm_status', 25754);
select public.checkout_attempt_subscription('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111',
  'sub_status', 'price_status', 'active');
select is((select dossier_exists from public.checkout_attempt_status_by_session('cs_test_status')), false,
  'Paiement et abonnement Stripe enregistrés : pas encore de dossier');

-- Même une marque de finalisation ne constitue pas, seule, une preuve de dossier.
update public.checkout_attempts set completed_at = now() where stripe_session_id = 'cs_test_status';
select is((select dossier_exists from public.checkout_attempt_status_by_session('cs_test_status')), false,
  'Tentative marquée terminée sans dossier : existence non confirmée');
update public.checkout_attempts set completed_at = null where stripe_session_id = 'cs_test_status';
select public.checkout_attempt_finish('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111',
  'evt_status', now() + interval '7 days');
set local role service_role;
select is((select dossier_exists from public.checkout_attempt_status_by_session('cs_test_status')), true,
  'Webhook terminé : dossier client et mandat réellement retrouvés');
reset role;

create temp table status_before as select to_jsonb(a) as payload from public.checkout_attempts a
  where stripe_session_id = 'cs_test_status';
select * from public.checkout_attempt_status_by_session('cs_test_status');
select * from public.checkout_attempt_status_by_session('cs_test_unknown');
select is((select to_jsonb(a) from public.checkout_attempts a where stripe_session_id = 'cs_test_status'),
  (select payload from status_before), 'Consultation : tentative inchangée, verrou et remboursement compris');
select is((select provolatile::text from pg_proc where oid = 'public.checkout_attempt_status_by_session(text)'::regprocedure),
  's', 'Fonction SQL STABLE : lecture seulement');

delete from public.subscriptions where stripe_subscription_id = 'sub_status';
select is((select dossier_exists from public.checkout_attempt_status_by_session('cs_test_status')), false,
  'Dossier lié absent après suppression : aucune confirmation fondée sur completed_at seul');

select * from finish();
rollback;
