-- Tests des opérations atomiques et des vues dérivées.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
-- pgTAP est créé après le retrait du défaut EXECUTE : on l'ouvre aux rôles testés
grant execute on all functions in schema extensions to anon, authenticated;

select plan(40);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000c', 'chloe@exemple.ca');
create temp table ids (k text primary key, v uuid) on commit drop;

insert into ids select 'C', public.handle_checkout_completed(
  'evt_C', 'chloe@exemple.ca', 'Chloé', 'depart', 'annual', date_trunc('month', current_date)::date,
  'cus_C', 'sub_C', 'active', true, true, 18, now() + interval '7 days',
  79000, 20, 450, 4900, 'depart_annual_2026_10_21', 5000, '2026-10-21', 2, 'annual', true, 1500, 2500, '(514) 555-0123');
insert into ids select 'S', id from public.subscriptions where stripe_subscription_id = 'sub_C';
insert into ids select 'M', mandate_id from public.subscriptions where stripe_subscription_id = 'sub_C';

select is((select activation_status from public.mandate_status where client_id = (select v from ids where k = 'C')),
  'intake_pending', 'Activation : fiche à remplir au départ');
select is((select commitment_ends_on from public.mandate_status where client_id = (select v from ids where k = 'C')),
  (date_trunc('month', current_date) + interval '12 months')::date, 'Annuel : engagement de 12 mois dérivé');

-- Hausse aujourd'hui, puis baisse prévue au mois suivant, puis nouvelle hausse qui la remplace
select public.change_plan((select v from ids where k = 'S'), 'elan', private.today(), 149000, 50, 450, 'elan_annual_2026_10_21', '2026-10-21', 3, 'quarterly', false, 1500, 2500, 7500, 7400);
select is((select plan_code from public.mandate_status where client_id = (select v from ids where k = 'C')),
  'elan', 'Forfait : hausse immédiate');
select public.change_plan((select v from ids where k = 'S'), 'depart', (date_trunc('month', current_date) + interval '1 month')::date, 79000, 20, 450, 'depart_annual_2026_10_21', '2026-10-21', 2, 'annual', true, 1500, 2500);
select is((select plan_code from public.mandate_status where client_id = (select v from ids where k = 'C')),
  'elan', 'Forfait : la baisse attend le mois suivant');
select is((select count(*) from public.subscription_plan_periods where subscription_id = (select v from ids where k = 'S')),
  3::bigint, 'Forfait : historique conservé (départ, élan, départ prévu)');
select is((select included_accounts::text || '/' || included_filing_frequency::text || '/' || quickbooks_included::text
           from public.subscription_plan_periods
           where subscription_id = (select v from ids where k = 'S') and effective_from = private.today()),
  '3/quarterly/false', 'Conditions accordées : droits du forfait photographiés à la hausse');
select is((select opening_fee_cents || '/' || opening_discount_cents from public.subscriptions where id = (select v from ids where k = 'S')),
  '7500/7400', 'Conditions accordées : ouverture et rabais mis à jour à la hausse');
select throws_ok($$ select public.change_plan((select v from ids where k = 'S'), 'envol', private.today(), 249000, 100, 450,
  'envol_annual_2026_10_21', '2026-10-21', 5, 'quarterly', false, 1500, 2500, 9900, null) $$,
  '22023', null, 'Conditions accordées : total et rabais d''ouverture vont ensemble');

-- Compteur P1
insert into public.monthly_transaction_counts (client_id, month, transaction_count)
select v, date_trunc('month', current_date)::date, 57 from ids where k = 'C';
select is((select extra_transactions from public.transaction_counter where client_id = (select v from ids where k = 'C')),
  7, 'Compteur : 57 / 50 = 7 transactions supplémentaires');
select is((select extra_amount_cents from public.transaction_counter where client_id = (select v from ids where k = 'C')),
  3150, 'Compteur : 7 × 4,50 $ selon les conditions accordées');
select is((select recurring_price_cents from public.mandate_status where client_id = (select v from ids where k = 'C')),
  149000, 'Photographie : prix accordé sur la période en vigueur (Élan annuel)');

-- Solde de taxes : à payer, à recevoir ou nul
select lives_ok($$ insert into public.tax_filings (client_id, period_start, period_end, due_on, balance_kind, amount_cents)
  select v, '2026-01-01', '2026-12-31', '2027-04-30', 'refund', 41250 from ids where k = 'C' $$,
  'Taxes : remboursement représenté');
select throws_ok($$ insert into public.tax_filings (client_id, period_start, period_end, due_on, balance_kind, amount_cents)
  select v, '2025-01-01', '2025-12-31', '2026-04-30', 'payable', 0 from ids where k = 'C' $$,
  '23514', null, 'Taxes : un montant à payer ne peut pas être nul');
update public.intake_forms set activity_type_code = 'self_employed', gst_qst_registered = true, gst_qst_frequency = 'annual'
where mandate_id = (select v from ids where k = 'M');

-- Pause, deuxième pause, fermeture
select lives_ok($$ select public.pause_mandate((select v from ids where k = 'M'), current_date + 30) $$, 'Pause : créée');
select throws_ok($$ select public.pause_mandate((select v from ids where k = 'M'), current_date + 31) $$,
  '23505', null, 'Pause : une seule à la fois');
select is(public.check_signup_eligibility('chloe@exemple.ca'), 'active', 'Inscription : refusée tant qu''un mandat est ouvert');
select throws_ok($$ insert into public.mandates (client_id) select v from ids where k = 'C' $$,
  'P0004', null, 'Mandat : un seul ouvert par client');
select public.close_mandate((select v from ids where k = 'M'), 'temporary', 'no_response', (current_date + interval '6 years')::date);
select is((select lifecycle_status from public.mandate_status where client_id = (select v from ids where k = 'C')),
  'closed', 'Fermeture : dossier fermé');
select is((select outcome::text from public.pauses where mandate_id = (select v from ids where k = 'M')),
  'closed', 'Fermeture : la pause est close');

select is((select closure_kind::text from public.mandate_status where client_id = (select v from ids where k = 'C')),
  'temporary', 'Fermeture : temporaire');

-- Fermeture temporaire : le client revient (même dossier, nouveau mandat, pas de nouvelle invitation)
select is(public.check_signup_eligibility('Chloe@exemple.ca'), 'returning', 'Inscription : ancien client accepté');
select is(public.handle_checkout_completed(
  'evt_C2', 'chloe@exemple.ca', 'Chloé', 'elan', 'monthly', current_date,
  'cus_C', 'sub_C2', 'active', true, true, 40, now() + interval '7 days',
  14900, 50, 450, 14900, 'elan_monthly_2026_10_21', 0, '2026-10-21', 3, 'quarterly', false, 1500, 2500),
  (select v from ids where k = 'C'), 'Réouverture : même client');
select is((select count(*) from public.mandates where client_id = (select v from ids where k = 'C')),
  2::bigint, 'Réouverture : nouveau mandat');
select is((select f.activity_type_code || '/' || coalesce(f.completed_at::text, 'à confirmer')
           from public.intake_forms f join public.mandates m on m.id = f.mandate_id
           where m.client_id = (select v from ids where k = 'C') order by m.opened_at desc limit 1),
  'self_employed/à confirmer', 'Réouverture : nouvelle fiche préremplie, à confirmer');

-- Fermeture définitive : le client n'est plus accepté
select public.close_mandate(
  (select m.id from public.mandates m where m.client_id = (select v from ids where k = 'C')
     and not exists (select 1 from public.mandate_closures c where c.mandate_id = m.id)),
  'permanent', 'non_payment', (current_date + interval '6 years')::date);
select is(public.check_signup_eligibility('chloe@exemple.ca'), 'refused', 'Inscription : client fermé définitivement refusé');
select throws_ok($$ select public.handle_checkout_completed(
  'evt_C3', 'chloe@exemple.ca', 'Chloé', 'depart', 'monthly', current_date,
  'cus_C', 'sub_C3', 'active', true, true, 10, now() + interval '7 days',
  7900, 20, 450, 9900, 'depart_monthly_2026_10_21', 0, '2026-10-21', 2, 'annual', true, 1500, 2500) $$,
  'P0003', null, 'Paiement d''un client refusé : erreur pour rembourser');

select is(public.check_signup_eligibility('autre@exemple.ca', '+1 514 555 0123'), 'review',
  'Même téléphone, autre courriel : accepté mais à vérifier (numéro peut-être réattribué)');
select is(public.check_signup_eligibility('autre@exemple.ca', null, 'cus_C'), 'refused',
  'Refus : même client Stripe, autre courriel');
select is(public.check_signup_eligibility('autre@exemple.ca', '438 555 9999', 'cus_Z'), 'new',
  'Personne inconnue : acceptée');

-- Inscription avec le téléphone d'un client refusé : dossier créé avec une alerte
insert into ids select 'N', public.handle_checkout_completed(
  'evt_C4', 'nouvelle@exemple.ca', 'Nadia', 'depart', 'monthly', current_date,
  'cus_N', 'sub_C4', 'active', true, true, 10, now() + interval '7 days',
  7900, 20, 450, 9900, 'depart_monthly_2026_10_21', 0, '2026-10-21', 2, 'annual', true, 1500, 2500, '514-555-0123');
insert into ids select 'MN', id from public.mandates where client_id = (select v from ids where k = 'N');
select is((select identity_check from public.mandate_status where mandate_id = (select v from ids where k = 'MN')),
  'pending', 'Alerte : vérification à faire');
update public.mandates set welcome_call_done_at = now(), quickbooks_ready_at = now()
where id = (select v from ids where k = 'MN');
select throws_ok($$ update public.mandates set activated_at = now() where id = (select v from ids where k = 'MN') $$,
  '23514', null, 'Alerte : activation impossible avant la vérification');
select lives_ok($$ select public.review_signup((select v from ids where k = 'MN'), 'different_person', null) $$,
  'Vérification : autre personne');
select lives_ok($$ update public.mandates set activated_at = now() where id = (select v from ids where k = 'MN') $$,
  'Vérification faite : activation possible');

-- Même personne confirmée à l'appel : fermeture définitive, l'adresse est refusée ensuite
insert into ids select 'P', public.handle_checkout_completed(
  'evt_C6', 'chloe.bis@exemple.ca', 'Chloé', 'depart', 'monthly', current_date,
  'cus_P', 'sub_C6', 'active', true, true, 10, now() + interval '7 days',
  7900, 20, 450, 9900, 'depart_monthly_2026_10_21', 0, '2026-10-21', 2, 'annual', true, 1500, 2500, '5145550123');
select public.review_signup((select id from public.mandates where client_id = (select v from ids where k = 'P')),
  'same_person', null, (current_date + interval '6 years')::date);
select is((select closure_kind::text from public.mandate_status where client_id = (select v from ids where k = 'P')),
  'permanent', 'Même personne : fermeture définitive');
select is(public.check_signup_eligibility('chloe.bis@exemple.ca'), 'refused', 'Même personne : nouvelle adresse refusée ensuite');

-- Annulation de la fermeture définitive
select throws_ok($$ select public.lift_permanent_closure(
  (select m.id from public.mandates m join public.mandate_closures c on c.mandate_id = m.id
   where m.client_id = (select v from ids where k = 'C') and c.kind = 'temporary'), 'Erreur', null) $$,
  '23514', null, 'Annulation : impossible sur une fermeture temporaire');
select lives_ok($$ select public.lift_permanent_closure(
  (select m.id from public.mandates m join public.mandate_closures c on c.mandate_id = m.id
   where m.client_id = (select v from ids where k = 'C') and c.kind = 'permanent'), 'Dette réglée', null) $$,
  'Annulation : fermeture définitive annulée');
select is(public.check_signup_eligibility('chloe@exemple.ca'), 'returning', 'Annulation : le client peut revenir');
select is(public.check_signup_eligibility('autre@exemple.ca', null, 'cus_C'), 'new', 'Annulation : le client Stripe ne bloque plus');
select isnt(public.handle_checkout_completed(
  'evt_C5', 'chloe@exemple.ca', 'Chloé', 'depart', 'monthly', current_date,
  'cus_C', 'sub_C5', 'active', true, true, 10, now() + interval '7 days',
  7900, 20, 450, 9900, 'depart_monthly_2026_10_21', 0, '2026-10-21', 2, 'annual', true, 1500, 2500),
  null, 'Annulation : réinscription acceptée');

select * from finish();
rollback;
