-- Tentatives d'inscription : validation, parcours, refus, inscriptions simultanées,
-- état d'abonnement, vue d'administration, purge et privilèges.
-- Les récapitulatifs sont la sortie réelle de quoteCheckout() (20 octobre 2026);
-- un test Deno vérifie qu'ils suivent toujours domain/pricing.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
grant execute on all functions in schema extensions to anon, authenticated;

select plan(47);

create temp table q (k text primary key, v jsonb) on commit drop;
grant select on q to authenticated;
insert into q values
  ('elan',   '{"terms":{"gridVersion":"2026-10","planCode":"elan","billingOption":"monthly_commitment","cycle":"month","recurringPriceCents":14900,"includedTransactions":50,"extraTransactionCents":450,"includedAccounts":3,"extraAccountCents":1500,"includedFilingFrequency":"quarterly","extraFilingCents":2500,"quickbooksIncluded":false,"openingFeeCents":7500,"openingDiscountCents":7400,"stripeRecurringLookupKey":"elan_monthly_2026_10"},"startsOn":"2026-10-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":7500,"gstCents":375,"qstCents":748},{"kind":"first_period","amountCents":14900,"gstCents":745,"qstCents":1486}],"subtotalCents":22400,"gstCents":1120,"qstCents":2234,"totalCents":25754},"recurring":{"amountCents":14900,"gstCents":745,"qstCents":1486,"totalCents":17131,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":"2027-10-01","extraTransactionCents":450,"currentMonthBooksUpdate":null,"taxRegion":"QC"}'),
  ('trajet', '{"terms":{"gridVersion":"2026-10","planCode":"trajet","billingOption":"monthly","cycle":"month","recurringPriceCents":4900,"includedTransactions":15,"extraTransactionCents":450,"includedAccounts":1,"extraAccountCents":1500,"includedFilingFrequency":"annual","extraFilingCents":2500,"quickbooksIncluded":true,"openingFeeCents":4900,"openingDiscountCents":0,"stripeRecurringLookupKey":"trajet_monthly_2026_10"},"startsOn":"2026-11-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":4900,"gstCents":245,"qstCents":489}],"subtotalCents":4900,"gstCents":245,"qstCents":489,"totalCents":5634},"recurring":{"amountCents":4900,"gstCents":245,"qstCents":489,"totalCents":5634,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":null,"extraTransactionCents":450,"currentMonthBooksUpdate":{"fromCents":12000,"month":"2026-10-01"},"taxRegion":"QC"}');
-- 1. Récapitulatif complet et cohérent, vérifié avant le paiement
select ok(private.is_valid_checkout_quote((select v from q where k = 'elan')), 'Récapitulatif du domaine : valide');
select ok(private.is_valid_checkout_quote((select v from q where k = 'trajet')), 'Trajet, mois suivant : valide');
select ok(not private.is_valid_checkout_quote((select v #- '{terms,includedAccounts}' from q where k = 'elan')), 'Clé absente : invalide, jamais « inconnu »');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{dueToday,totalCents}', '22500') from q where k = 'elan')), 'Total différent de la somme des lignes : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{recurring,amountCents}', '7900') from q where k = 'elan')), 'Montant récurrent différent du prix accordé : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{terms,stripeRecurringLookupKey}', '"depart_monthly_2026_10"') from q where k = 'elan')), 'Clé Stripe d''un autre forfait : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(jsonb_set(v, '{terms,billingOption}', '"annual"'), '{terms,cycle}', '"year"') from q where k = 'trajet')), 'Trajet à l''année : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{recurring,nextChargeOn}', '"2026-12-01"') from q where k = 'elan')), 'Prochain prélèvement incohérent : invalide');
select throws_ok($$ select public.checkout_attempt_create('a0000000-0000-4000-8000-000000000001', 'x@exemple.ca', '514', 'X',
  true, false, 10, (select jsonb_set(v, '{dueToday,totalCents}', '1') from q where k = 'elan')) $$,
  '22023', null, 'Récapitulatif incohérent : refusé avant le paiement');
-- 2. Parcours complet : Élan avec engagement, mois en cours
select lives_ok($$ select public.checkout_attempt_create('a1111111-1111-4111-8111-111111111111', 'Elise@Exemple.ca',
  '514 555 0101', 'Élise Conseil', true, false, 40, (select v from q where k = 'elan')) $$, 'Tentative enregistrée');
select is((select email from public.checkout_attempts where id = 'a1111111-1111-4111-8111-111111111111'), 'elise@exemple.ca', 'Courriel en minuscules');
select throws_ok($$ select public.checkout_attempt_create('a9999999-9999-4999-8999-999999999999', 'elise@exemple.ca',
  '514 555 0101', 'Élise', true, false, 40, (select v from q where k = 'elan')) $$,
  'P0005', null, 'Deuxième inscription simultanée : refusée');
select is(public.checkout_attempt_open_for('ELISE@exemple.ca'), 'a1111111-1111-4111-8111-111111111111'::uuid, 'La tentative ouverte est retrouvée pour être reprise');
select public.checkout_attempt_save_session('a1111111-1111-4111-8111-111111111111', 'cs_test_elise');
select ok(public.checkout_attempt_claim('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111'), 'Verrou acquis');
select ok(not public.checkout_attempt_claim('a1111111-1111-4111-8111-111111111111', 'b2222222-2222-4222-8222-222222222222'), 'Un deuxième webhook attend son tour');
select throws_ok($$ select public.checkout_attempt_paid('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111', 'cs_autre', 'cus_elise', 'pi_elise', 'pm_elise', 25754) $$,
  'P0001', null, 'Paiement d''une autre session : refusé');
select public.checkout_attempt_paid('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111', 'cs_test_elise', 'cus_elise', 'pi_elise', 'pm_elise', 25754);
select throws_ok($$ select public.checkout_attempt_abandon('a1111111-1111-4111-8111-111111111111') $$, 'P0001', null, 'Une tentative payée ne peut pas être abandonnée');
select public.checkout_attempt_subscription('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111', 'sub_elise', 'price_elan_monthly', 'active');
select isnt(public.checkout_attempt_finish('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111', 'evt_elise', now() + interval '7 days'), null::uuid, 'Dossier créé');
select is((select pp.plan_code || '/' || pp.recurring_price_cents || '/' || pp.included_accounts || '/' ||
                  pp.included_filing_frequency || '/' || pp.quickbooks_included || '/' || pp.grid_version || '/' ||
                  s.opening_fee_cents || '/' || s.opening_discount_cents
           from public.subscription_plan_periods pp join public.subscriptions s on s.id = pp.subscription_id
           where s.stripe_subscription_id = 'sub_elise'),
  'elan/14900/3/quarterly/false/2026-10/7500/7400', 'Toutes les conditions accordées sont enregistrées');
select is(public.checkout_attempt_finish('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111', 'evt_elise_bis', now() + interval '7 days'),
  (select m.client_id from public.mandates m join public.subscriptions s on s.mandate_id = m.id where s.stripe_subscription_id = 'sub_elise'),
  'Webhook rejoué : même dossier, aucun doublon');
select is((select count(*) from public.mandates m join public.clients c on c.id = m.client_id where c.contact_email = 'elise@exemple.ca'), 1::bigint, 'Un seul mandat');
select public.checkout_attempt_release('a1111111-1111-4111-8111-111111111111', 'b1111111-1111-4111-8111-111111111111');
select throws_ok($$ select public.checkout_attempt_create('a8888888-8888-4888-8888-888888888888', 'elise@exemple.ca',
  '514 555 0101', 'Élise', true, false, 40, (select v from q where k = 'elan')) $$,
  'P0004', null, 'Dossier ouvert : nouvelle inscription refusée avant paiement');
-- 3. Ancien client : pas de réouverture par le site
select public.close_mandate((select m.id from public.mandates m join public.clients c on c.id = m.client_id
  where c.contact_email = 'elise@exemple.ca'), 'temporary', 'client_request', (current_date + interval '6 years')::date);
select throws_ok($$ select public.checkout_attempt_create('a7777777-7777-4777-8777-777777777777', 'elise@exemple.ca',
  '514 555 0101', 'Élise', true, false, 40, (select v from q where k = 'elan')) $$,
  'P0006', null, 'Ancien client : réouverture par l''application, jamais sur la foi d''un courriel');
-- 4. Paiement sans dossier retrouvé : jamais « terminée »
select public.checkout_attempt_create('a5555555-5555-4555-8555-555555555555', 'eve@exemple.ca', '514 555 0105', 'Ève', true, false, 30, (select v from q where k = 'elan'));
select public.checkout_attempt_save_session('a5555555-5555-4555-8555-555555555555', 'cs_test_eve');
select public.checkout_attempt_claim('a5555555-5555-4555-8555-555555555555', 'e1111111-1111-4111-8111-111111111111');
select public.checkout_attempt_paid('a5555555-5555-4555-8555-555555555555', 'e1111111-1111-4111-8111-111111111111', 'cs_test_eve', 'cus_eve', 'pi_eve', 'pm_eve', 25754);
select public.checkout_attempt_subscription('a5555555-5555-4555-8555-555555555555', 'e1111111-1111-4111-8111-111111111111', 'sub_eve', 'price_elan_monthly', 'active');
select public.record_stripe_event('evt_deja_vu', 'checkout.session.completed');
select throws_ok($$ select public.checkout_attempt_finish('a5555555-5555-4555-8555-555555555555', 'e1111111-1111-4111-8111-111111111111', 'evt_deja_vu', now() + interval '7 days') $$,
  'P0001', null, 'Événement déjà traité mais aucun dossier : erreur, pas de fausse réussite');
select is((select completed_at from public.checkout_attempts where id = 'a5555555-5555-4555-8555-555555555555'), null, 'La tentative reste « payée sans dossier »');
-- 5. Refus après paiement : seulement avec le remboursement complet
select public.checkout_attempt_create('a2222222-2222-4222-8222-222222222222', 'tom@exemple.ca', '438 555 0102', 'Tom Livraison', true, false, 12, (select v from q where k = 'trajet'));
select public.checkout_attempt_save_session('a2222222-2222-4222-8222-222222222222', 'cs_test_tom');
select public.checkout_attempt_claim('a2222222-2222-4222-8222-222222222222', 'c1111111-1111-4111-8111-111111111111');
select public.checkout_attempt_paid('a2222222-2222-4222-8222-222222222222', 'c1111111-1111-4111-8111-111111111111', 'cs_test_tom', 'cus_tom', 'pi_tom', 'pm_tom', 5634);
select throws_ok($$ select public.checkout_attempt_reject('a2222222-2222-4222-8222-222222222222', 'c1111111-1111-4111-8111-111111111111', 're_tom', 2000, 'succeeded', 'inscription_refused') $$,
  'P0001', null, 'Remboursement partiel : refus non enregistré');
select throws_ok($$ select public.checkout_attempt_reject('a2222222-2222-4222-8222-222222222222', 'c1111111-1111-4111-8111-111111111111', 're_tom', 5634, 'failed', 'inscription_refused') $$,
  'P0001', null, 'Remboursement refusé par Stripe : refus non enregistré');
select lives_ok($$ select public.checkout_attempt_reject('a2222222-2222-4222-8222-222222222222', 'c1111111-1111-4111-8111-111111111111', 're_tom', 5634, 'pending', 'inscription_refused') $$,
  'Remboursement complet en cours : refus enregistré');
select throws_ok($$ select public.checkout_attempt_finish('a2222222-2222-4222-8222-222222222222', 'c1111111-1111-4111-8111-111111111111', 'evt_tom', now() + interval '7 days') $$,
  'P0001', null, 'Tentative refusée : jamais de dossier');
select public.checkout_attempt_refund_status('a2222222-2222-4222-8222-222222222222', 're_tom', 'failed');
-- 6. Abandon : session expirée, puis paiement tardif remboursé
select public.checkout_attempt_create('a3333333-3333-4333-8333-333333333333', 'ana@exemple.ca', '450 555 0103', 'Ana', true, false, 10, (select v from q where k = 'trajet'));
select public.checkout_attempt_save_session('a3333333-3333-4333-8333-333333333333', 'cs_test_ana');
select lives_ok($$ select public.checkout_attempt_abandon('a3333333-3333-4333-8333-333333333333') $$, 'Tentative jamais payée : abandonnée');
select lives_ok($$ select public.checkout_attempt_create('a4444444-4444-4444-8444-444444444444', 'ana@exemple.ca', '450 555 0103', 'Ana', true, false, 10, (select v from q where k = 'trajet')) $$,
  'Après l''abandon, une nouvelle inscription est possible');
select public.checkout_attempt_claim('a3333333-3333-4333-8333-333333333333', 'd1111111-1111-4111-8111-111111111111');
select public.checkout_attempt_paid('a3333333-3333-4333-8333-333333333333', 'd1111111-1111-4111-8111-111111111111', 'cs_test_ana', 'cus_ana', 'pi_ana', 'pm_ana', 5634);
select throws_ok($$ select public.checkout_attempt_subscription('a3333333-3333-4333-8333-333333333333', 'd1111111-1111-4111-8111-111111111111', 'sub_ana', 'price_trajet', 'active') $$,
  'P0001', null, 'Payée après l''abandon : jamais d''abonnement');
select lives_ok($$ select public.checkout_attempt_reject('a3333333-3333-4333-8333-333333333333', 'd1111111-1111-4111-8111-111111111111', 're_ana', 5634, 'succeeded', 'paid_after_abandon') $$,
  'Payée après l''abandon : remboursée');
update public.checkout_attempts set created_at = now() - interval '25 hours' where id = 'a4444444-4444-4444-8444-444444444444';
select throws_ok($$ select public.checkout_attempt_create('a6666666-6666-4666-8666-666666666666', 'ana@exemple.ca',
  '450 555 0103', 'Ana', true, false, 10, (select v from q where k = 'trajet')) $$,
  'P0005', null, 'Tentative non payée de plus de 24 h : jamais abandonnée par la base (Stripe décide)');
-- 7. État de l'abonnement relu chez Stripe
select throws_ok($$ select public.apply_stripe_subscription_state('evt_inconnu', 'invoice.paid', 'sub_absent', 'active', now()) $$,
  'P0001', null, 'Abonnement pas encore associé : erreur pour que Stripe renvoie l''événement');
select is((select count(*) from public.stripe_events where id = 'evt_inconnu'), 0::bigint, 'L''événement en erreur n''est pas marqué reçu');
select public.apply_stripe_subscription_state('evt_s1', 'invoice.payment_failed', 'sub_elise', 'past_due', '2026-11-02 10:00+00');
select is((select payment_failed_at from public.subscriptions where stripe_subscription_id = 'sub_elise'), '2026-11-02 10:00+00'::timestamptz, 'En retard : début du délai de grâce');
select public.apply_stripe_subscription_state('evt_s2', 'invoice.paid', 'sub_elise', 'active', '2026-11-03 10:00+00');
select public.apply_stripe_subscription_state('evt_s3', 'customer.subscription.updated', 'sub_elise', 'past_due', '2026-11-02 12:00+00');
select is((select stripe_status || '/' || coalesce(payment_failed_at::text, 'aucun') from public.subscriptions where stripe_subscription_id = 'sub_elise'), 'active/aucun', 'Une lecture plus ancienne arrivée en retard est ignorée');
select ok(not public.apply_stripe_subscription_state('evt_s2', 'invoice.paid', 'sub_elise', 'active', now()), 'Même événement reçu deux fois : ignoré');
-- 8. Vue d'administration
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000ad', 'admin@firme.ca');
insert into public.admins (user_id) values ('00000000-0000-0000-0000-0000000000ad');
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'client@exemple.ca');
update public.checkout_attempts set paid_at = now() - interval '1 hour' where id = 'a5555555-5555-4555-8555-555555555555';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ad","aal":"aal2"}', true);
select is((select string_agg(category, ',' order by created_at, id) from public.admin_checkout_attempts
  where id in ('a1111111-1111-4111-8111-111111111111', 'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333', 'a5555555-5555-4555-8555-555555555555')),
  (select string_agg(c, ',' order by created_at, id) from (values
     ((select created_at from public.checkout_attempts where id = 'a1111111-1111-4111-8111-111111111111'), 'a1111111-1111-4111-8111-111111111111'::uuid, 'completed'),
     ((select created_at from public.checkout_attempts where id = 'a5555555-5555-4555-8555-555555555555'), 'a5555555-5555-4555-8555-555555555555'::uuid, 'to_handle'),
     ((select created_at from public.checkout_attempts where id = 'a2222222-2222-4222-8222-222222222222'), 'a2222222-2222-4222-8222-222222222222'::uuid, 'to_handle'),
     ((select created_at from public.checkout_attempts where id = 'a3333333-3333-4333-8333-333333333333'), 'a3333333-3333-4333-8333-333333333333'::uuid, 'refused')) v(created_at, id, c)),
  'Administratrice : terminée, payée sans dossier et remboursement en échec « à traiter », refusée');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000ad","aal":"aal1"}', true);
select is((select count(*) from public.admin_checkout_attempts), 0::bigint, 'Sans double authentification : rien');
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000000c","aal":"aal2"}', true);
select is((select count(*) from public.checkout_attempts), 0::bigint, 'Un client connecté ne voit aucune tentative');
select throws_ok($$ select public.checkout_attempt_claim('a1111111-1111-4111-8111-111111111111', gen_random_uuid()) $$, '42501', null, 'Un client connecté ne peut rien modifier');
reset role;
-- 9. Purge (Loi 25)
update public.checkout_attempts set created_at = now() - interval '31 days' where paid_at is null;
update public.checkout_attempts set completed_at = now() - interval '91 days' where id = 'a1111111-1111-4111-8111-111111111111';
update public.checkout_attempts set rejected_at = now() - interval '91 days' where id in ('a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333');
select is((select deleted_unpaid || '/' || deleted_completed || '/' || anonymized_refused from public.purge_checkout_attempts()),
  '1/1/1', 'Purge : non payées et terminées supprimées, refusée remboursée anonymisée');
select is((select email || '/' || refund_amount_cents from public.checkout_attempts where id = 'a3333333-3333-4333-8333-333333333333'),
  'efface+a3333333-3333-4333-8333-333333333333@invalid/5634', 'Refusée : coordonnées effacées, montant remboursé gardé');
select is((select email from public.checkout_attempts where id = 'a2222222-2222-4222-8222-222222222222'), 'tom@exemple.ca',
  'Remboursement en échec : rien n''est effacé tant que ce n''est pas réglé');
select isnt((select id from public.checkout_attempts where id = 'a5555555-5555-4555-8555-555555555555'), null, 'Payée sans dossier : jamais purgée');

select * from finish();
rollback;
