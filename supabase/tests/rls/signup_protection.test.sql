-- Protection de l'inscription : empreinte des choix, suivi des remboursements, limite d'appels.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

select plan(14);

-- 1. Empreinte des choix
select throws_ok($$ select public.checkout_attempt_create('a1111111-1111-4111-8111-111111111111', 'elise@exemple.ca',
  '514 555 0101', 'Élise', true, false, 40, '{"terms":{"gridVersion":"2026-10","planCode":"elan","billingOption":"monthly_commitment","cycle":"month","recurringPriceCents":14900,"includedTransactions":50,"extraTransactionCents":450,"includedAccounts":3,"extraAccountCents":1500,"includedFilingFrequency":"quarterly","extraFilingCents":2500,"quickbooksIncluded":false,"openingFeeCents":7500,"openingDiscountCents":7400,"stripeRecurringLookupKey":"elan_monthly_2026_10"},"startsOn":"2026-10-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":7500},{"kind":"first_period","amountCents":14900}],"totalCents":22400},"recurring":{"amountCents":14900,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":"2027-10-01","extraTransactionCents":450,"currentMonthBooksUpdate":null,"taxesIncluded":false}'::jsonb, 'pas-une-empreinte') $$,
  '23514', null, 'Empreinte mal formée : refusée');
select lives_ok($$ select public.checkout_attempt_create('a1111111-1111-4111-8111-111111111111', 'elise@exemple.ca',
  '514 555 0101', 'Élise', true, false, 40, '{"terms":{"gridVersion":"2026-10","planCode":"elan","billingOption":"monthly_commitment","cycle":"month","recurringPriceCents":14900,"includedTransactions":50,"extraTransactionCents":450,"includedAccounts":3,"extraAccountCents":1500,"includedFilingFrequency":"quarterly","extraFilingCents":2500,"quickbooksIncluded":false,"openingFeeCents":7500,"openingDiscountCents":7400,"stripeRecurringLookupKey":"elan_monthly_2026_10"},"startsOn":"2026-10-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":7500},{"kind":"first_period","amountCents":14900}],"totalCents":22400},"recurring":{"amountCents":14900,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":"2027-10-01","extraTransactionCents":450,"currentMonthBooksUpdate":null,"taxesIncluded":false}'::jsonb, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') $$, 'Tentative avec empreinte');
select is((select request_fingerprint from public.checkout_attempts where id = 'a1111111-1111-4111-8111-111111111111'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Empreinte conservée');

-- 2. Suivi d'un remboursement
select is(public.checkout_attempt_refund_status('a0000000-0000-4000-8000-000000000000', 're_x', 'succeeded'), 'unknown_attempt', 'Tentative inconnue : ignoré');
select is(public.checkout_attempt_refund_status('a1111111-1111-4111-8111-111111111111', 're_1', 'succeeded'), 'not_recorded', 'Remboursement accepté pas encore enregistré : Stripe doit renvoyer');
select is(public.checkout_attempt_refund_status('a1111111-1111-4111-8111-111111111111', 're_0', 'failed'), 'ignored', 'Remboursement échoué avant le refus : jamais enregistré');
select public.checkout_attempt_save_session('a1111111-1111-4111-8111-111111111111', 'cs_elise');
select public.checkout_attempt_claim('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111');
select public.checkout_attempt_paid('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111', 'cs_elise', 'cus_e', 'pi_e', 'pm_e', 22400);
select public.checkout_attempt_reject('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111', 're_1', 22400, 'pending', 'inscription_refused');
select is(public.checkout_attempt_refund_status('a1111111-1111-4111-8111-111111111111', 're_1', 'succeeded'), 'updated', 'Remboursement enregistré : statut mis à jour');
select is(public.checkout_attempt_refund_status('a1111111-1111-4111-8111-111111111111', 're_1', 'pending'), 'updated', 'Ancien statut arrivé en retard : accepté sans effet');
select is((select refund_status from public.checkout_attempts where id = 'a1111111-1111-4111-8111-111111111111'), 'succeeded', 'Jamais de retour de « réussi » à « en cours »');
select is(public.checkout_attempt_refund_status('a1111111-1111-4111-8111-111111111111', 're_0', 'succeeded'), 'ignored', 'Autre remboursement d''une tentative déjà refusée : ignoré');
select throws_ok($$ select public.checkout_attempt_refund_status('a1111111-1111-4111-8111-111111111111', 're_1', 'bizarre') $$, '22023', null, 'Statut inconnu : refusé');

-- 3. Limite d'appels
select ok((select bool_and(public.rate_limit_hit('checkout:ip:203.0.113.7', 3, 3600)) from generate_series(1, 3)), 'Trois appels permis');
select ok(not public.rate_limit_hit('checkout:ip:203.0.113.7', 3, 3600), 'Quatrième appel refusé');
select is((select count(*) from private.rate_limit_hits where key_hash like '%203.0.113.7%'), 0::bigint, 'Aucune adresse IP conservée en clair');

select * from finish();
rollback;
