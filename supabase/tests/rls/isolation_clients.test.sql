-- Tests de sécurité : isolation entre clients, rôles, écritures interdites.
-- Lancer avec : supabase test db
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
-- pgTAP est créé après le retrait du défaut EXECUTE : on l'ouvre aux rôles testés
grant execute on all functions in schema extensions to anon, authenticated;

select plan(59);

-- ---------------------------------------------------------------------------
-- Données de départ (rôle postgres)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@exemple.ca'),
  ('00000000-0000-0000-0000-00000000000b', 'bruno@exemple.ca'),
  ('00000000-0000-0000-0000-0000000000ad', 'admin@firme.ca');
insert into public.admins (user_id) values ('00000000-0000-0000-0000-0000000000ad');

create temp table ids (k text primary key, v uuid) on commit drop;
grant select, insert on ids to authenticated, anon;

insert into ids select 'A', public.handle_checkout_completed(
  'evt_A', 'Alice@Exemple.ca', 'Alice inc.', 'depart', 'monthly_commitment', '2026-10-01',
  'cus_A', 'sub_A', 'active', true, false, 15, now() + interval '7 days',
  7900, 20, 450, 4900, 'depart_monthly_2026_10_21', 5000, '2026-10-21', 2, 'annual', true, 1500, 2500);
insert into ids select 'B', public.handle_checkout_completed(
  'evt_B', 'bruno@exemple.ca', 'Bruno Transport', 'trajet', 'monthly', '2026-10-01',
  'cus_B', 'sub_B', 'active', true, false, 10, now() + interval '7 days',
  5900, 20, 450, 5900, 'trajet_monthly_2026_10_21', 0, '2026-10-21', 2, 'annual', true, 1500, 2500);

select is(public.handle_checkout_completed(
  'evt_A', 'alice@exemple.ca', 'Alice inc.', 'depart', 'monthly', '2026-10-01',
  'cus_A2', 'sub_A2', 'active', true, false, 15, now() + interval '7 days',
  7900, 20, 450, 9900, 'depart_monthly_2026_10_21', 0, '2026-10-21', 2, 'annual', true, 1500, 2500),
  null, 'Stripe : un événement reçu deux fois ne crée pas un deuxième client');

select throws_ok(
  $$ select public.accept_invitation((select id from public.invitations where client_id = (select v from ids where k = 'A')),
                                     '00000000-0000-0000-0000-00000000000b') $$,
  '42501', null, 'Invitation : refusée pour une autre adresse');

select public.accept_invitation(id, '00000000-0000-0000-0000-00000000000a')
from public.invitations where client_id = (select v from ids where k = 'A');
select public.accept_invitation(id, '00000000-0000-0000-0000-00000000000b')
from public.invitations where client_id = (select v from ids where k = 'B');

with x as (insert into public.questions (client_id, prompt) select v, 'Dépense Costco ?' from ids where k = 'A' returning id)
insert into ids select 'QA', id from x;
with x as (insert into public.questions (client_id, prompt) select v, 'Dépense Uber ?' from ids where k = 'B' returning id)
insert into ids select 'QB', id from x;
with x as (insert into public.questions (client_id, prompt) select v, 'Achat Bureau en Gros ?' from ids where k = 'A' returning id)
insert into ids select 'QA2', id from x;
with x as (insert into public.document_requests (client_id, document_type_code, title) select v, 'bank_statement', 'Relevé d''octobre' from ids where k = 'A' returning id)
insert into ids select 'RA', id from x;
with x as (insert into public.document_requests (client_id, document_type_code, title) select v, 'platform_report', 'Relevé Uber' from ids where k = 'B' returning id)
insert into ids select 'RB', id from x;
insert into public.messages (client_id, author_id, body)
select v, '00000000-0000-0000-0000-0000000000ad', 'Bienvenue' from ids where k in ('A', 'B');
insert into public.proposals (client_id, kind, title, amount_cents, plan_code)
select v, 'plan_change', 'Passer à Élan', 14900, 'elan' from ids where k = 'B';
insert into storage.objects (bucket_id, name)
select 'documents', v::text || '/00000000-0000-0000-0000-000000000099/1.jpg' from ids where k = 'B';

-- ---------------------------------------------------------------------------
-- Alice (cliente A), sans double authentification
-- ---------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","email":"alice@exemple.ca","aal":"aal1"}', true);

select is((select count(*) from public.clients), 1::bigint, 'Alice : voit un seul dossier');
select is((select display_name from public.clients), 'Alice inc.', 'Alice : c''est le sien');
select is((select count(*) from public.questions where client_id = (select v from ids where k = 'B')), 0::bigint, 'Alice : aucune question de B');
select is((select count(*) from public.document_requests where client_id = (select v from ids where k = 'B')), 0::bigint, 'Alice : aucune demande de B');
select is((select count(*) from public.messages), 1::bigint, 'Alice : seulement son fil de messages');
select is((select count(*) from public.proposals), 0::bigint, 'Alice : aucune proposition de B');
select is((select count(*) from public.mandates), 1::bigint, 'Alice : son mandat seulement');
select is((select count(*) from public.subscriptions), 1::bigint, 'Alice : son abonnement seulement');
select is((select count(*) from public.client_overview), 1::bigint, 'Vue client_overview : une ligne');
select is((select count(*) from storage.objects), 0::bigint, 'Stockage : aucun fichier de B');

select throws_ok($$ select * from public.stripe_events $$, '42501', null, 'Alice : pas d''accès aux événements Stripe');
select is((select count(*) from public.access_log), 0::bigint, 'Alice : journal des accès vide pour elle');

select throws_ok(
  $$ insert into public.messages (client_id, body) select v, 'Coucou' from ids where k = 'B' $$,
  '42501', null, 'Alice : ne peut pas écrire dans le dossier de B');
select lives_ok(
  $$ insert into public.messages (client_id, body) select v, 'Bonjour !' from ids where k = 'A' $$,
  'Alice : écrit dans son dossier');
select is((select author_id from public.messages where body = 'Bonjour !'),
  '00000000-0000-0000-0000-00000000000a'::uuid, 'Alice : l''auteur est fixé automatiquement');
select throws_ok(
  $$ insert into public.messages (client_id, body, author_id)
     select v, 'Faux', '00000000-0000-0000-0000-0000000000ad' from ids where k = 'A' $$,
  '42501', null, 'Alice : ne peut pas se faire passer pour la firme');

select throws_ok(
  $$ insert into public.proposals (client_id, kind, title, amount_cents) select v, 'books_update', 'x', 0 from ids where k = 'A' $$,
  '42501', null, 'Alice : aucune écriture directe dans les propositions');
select throws_ok(
  $$ update public.mandates set activated_at = now() $$,
  '42501', null, 'Alice : aucune écriture directe dans les mandats');
select throws_ok(
  $$ insert into public.question_answers (question_id, kind, body) select v, 'text', 'Mon chat' from ids where k = 'QB' $$,
  '42501', null, 'Alice : ne peut pas répondre à une question de B');
select lives_ok(
  $$ insert into public.question_answers (question_id, kind, body) select v, 'text', 'Fournitures' from ids where k = 'QA' $$,
  'Alice : répond à sa question');
select is((select status from public.question_status where question_id = (select v from ids where k = 'QA')),
  'answered', 'Vue question_status : répondue');

-- Envoi d'un document
with x as (insert into public.documents (client_id, direction, document_type_code)
  select v, 'from_client', 'bank_statement' from ids where k = 'A' returning id)
insert into ids select 'DA', id from x;

select throws_ok(
  $$ insert into public.document_pages (document_id, page_number, storage_path, mime_type, size_bytes)
     select v, 1, 'autre/chemin.jpg', 'image/jpeg', 1000 from ids where k = 'DA' $$,
  '42501', null, 'Page : refusée hors de son dossier');
select lives_ok(
  $$ insert into public.document_pages (document_id, page_number, storage_path, mime_type, size_bytes)
     select d.v, 1, a.v::text || '/' || d.v::text || '/1.jpg', 'image/jpeg', 1000
     from ids d, ids a where d.k = 'DA' and a.k = 'A' $$,
  'Page : ajoutée à son brouillon');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name)
     select 'documents', a.v::text || '/' || d.v::text || '/1.jpg' from ids d, ids a where d.k = 'DA' and a.k = 'A' $$,
  'Stockage : fichier déposé dans son brouillon');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     select 'documents', b.v::text || '/' || d.v::text || '/2.jpg' from ids d, ids b where d.k = 'DA' and b.k = 'B' $$,
  '42501', null, 'Stockage : refusé dans le dossier de B');
select throws_ok(
  $$ insert into public.request_documents (document_id, request_id)
     select d.v, r.v from ids d, ids r where d.k = 'DA' and r.k = 'RB' $$,
  '23514', null, 'Demande : impossible de déposer dans une demande de B');
select lives_ok(
  $$ insert into public.request_documents (document_id, request_id)
     select d.v, r.v from ids d, ids r where d.k = 'DA' and r.k = 'RA' $$,
  'Demande : document déposé dans sa demande');
select throws_ok(
  $$ update public.documents set sent_at = now() where id = (select v from ids where k = 'DA') $$,
  '42501', null, 'Envoi : sent_at ne se fixe pas directement');
with x as (insert into public.documents (client_id, direction, document_type_code)
           select v, 'from_client', 'receipt' from ids where k = 'A' returning id)
insert into ids select 'DA2', id from x;
insert into public.document_pages (document_id, page_number, storage_path, mime_type, size_bytes)
select d.v, 1, a.v::text || '/' || d.v::text || '/1.jpg', 'image/jpeg', 1000
from ids d, ids a where d.k = 'DA2' and a.k = 'A';
select throws_ok($$ select public.confirm_document_upload((select v from ids where k = 'DA2')) $$,
  'P0001', null, 'Envoi : refusé si le fichier n''a pas été téléversé');
select throws_ok(
  $$ insert into public.question_answers (question_id, kind, document_id)
     select q.v, 'receipt', d.v from ids q, ids d where q.k = 'QA2' and d.k = 'DA2' $$,
  '23514', null, 'Reçu : un document non envoyé ne peut pas servir de réponse');
select isnt(public.confirm_document_upload((select v from ids where k = 'DA')), null, 'Envoi : confirmé par la fonction');
select is((select status from public.document_request_status where request_id = (select v from ids where k = 'RA')),
  'received', 'Vue document_request_status : reçue');
select throws_ok(
  $$ insert into public.document_pages (document_id, page_number, storage_path, mime_type, size_bytes)
     select d.v, 2, a.v::text || '/' || d.v::text || '/2.jpg', 'image/jpeg', 1000
     from ids d, ids a where d.k = 'DA' and a.k = 'A' $$,
  '23514', null, 'Envoi : plus de page ajoutée après l''envoi');

-- Fiche de départ
with u as (update public.intake_forms
           set current_step = 2, activity_type_code = 'self_employed',
               gst_qst_registered = true, gst_qst_frequency = 'annual' returning 1)
select is((select count(*) from u), 1::bigint, 'Fiche : modifiable avant d''être terminée');

-- ---------------------------------------------------------------------------
-- Fonctions serveur et lecture seule (rôle postgres)
-- ---------------------------------------------------------------------------
reset role;
select public.complete_intake_form(
  (select id from public.mandates where client_id = (select v from ids where k = 'A')),
  '00000000-0000-0000-0000-00000000000a',
  '[{"document_type_code":"card_statement","title":"Relevé de carte"}]'::jsonb);
update public.subscriptions set payment_failed_at = now(), read_only_since = now()
where stripe_subscription_id = 'sub_A';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","email":"alice@exemple.ca","aal":"aal1"}', true);

with u as (update public.intake_forms set current_step = 3 returning 1)
select is((select count(*) from u), 0::bigint, 'Fiche : figée une fois terminée');
select is((select count(*) from public.document_requests where created_by is null and document_type_code = 'card_statement'), 1::bigint,
  'Fiche : la demande automatique est créée');
select is((select payment_status from public.mandate_status), 'read_only', 'Vue mandate_status : lecture seule');
select throws_ok(
  $$ insert into public.documents (client_id, direction, document_type_code) select v, 'from_client', 'receipt' from ids where k = 'A' $$,
  '42501', null, 'Lecture seule : plus d''envoi de document');
select lives_ok(
  $$ insert into public.messages (client_id, body) select v, 'Je règle le paiement' from ids where k = 'A' $$,
  'Lecture seule : les messages restent permis');

-- ---------------------------------------------------------------------------
-- Administratrice
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000ad","email":"admin@firme.ca","aal":"aal1"}', true);
select is((select count(*) from public.clients), 0::bigint, 'Admin sans double authentification : ne voit rien');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000ad","email":"admin@firme.ca","aal":"aal2"}', true);
select is((select count(*) from public.clients), 2::bigint, 'Admin avec double authentification : voit tous les dossiers');
select lives_ok(
  $$ insert into public.questions (client_id, prompt) select v, 'Retrait de 200 $ ?' from ids where k = 'B' $$,
  'Admin : crée une question');
select throws_ok(
  $$ insert into public.proposal_responses (proposal_id, decision) select id, 'accepted' from public.proposals $$,
  '42501', null, 'Admin : ne répond pas à la place du client');

-- Document de la firme en préparation : invisible pour le client jusqu'à la publication
with x as (insert into public.documents (client_id, direction, document_type_code, title)
           select v, 'from_firm', 'report', 'Rapport d''octobre' from ids where k = 'A' returning id)
insert into ids select 'DF', id from x;
insert into public.document_pages (document_id, page_number, storage_path, mime_type, size_bytes)
select d.v, 1, a.v::text || '/' || d.v::text || '/1.pdf', 'application/pdf', 5000
from ids d, ids a where d.k = 'DF' and a.k = 'A';
insert into storage.objects (bucket_id, name)
select 'documents', a.v::text || '/' || d.v::text || '/1.pdf' from ids d, ids a where d.k = 'DF' and a.k = 'A';
select throws_ok($$ update public.documents set sent_at = now() where id = (select v from ids where k = 'DF') $$,
  '42501', null, 'Admin : la publication passe par confirm_document_upload');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","email":"alice@exemple.ca","aal":"aal1"}', true);
select is((select count(*) from public.documents where id = (select v from ids where k = 'DF')), 0::bigint,
  'Confidentialité : document de la firme invisible avant publication');
select is((select count(*) from public.document_pages where document_id = (select v from ids where k = 'DF')), 0::bigint,
  'Confidentialité : pages invisibles avant publication');
select is((select count(*) from storage.objects where name like '%' || (select v from ids where k = 'DF')::text || '%'), 0::bigint,
  'Confidentialité : fichier illisible avant publication');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000ad","email":"admin@firme.ca","aal":"aal2"}', true);
select isnt(public.confirm_document_upload((select v from ids where k = 'DF')), null, 'Admin : document publié');

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","email":"alice@exemple.ca","aal":"aal1"}', true);
select is((select count(*) from storage.objects where name like '%' || (select v from ids where k = 'DF')::text || '%'), 1::bigint,
  'Confidentialité : fichier lisible une fois publié');

-- ---------------------------------------------------------------------------
-- Visiteur non connecté
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($$ select * from public.clients $$, '42501', null, 'Anonyme : aucun accès');

-- ---------------------------------------------------------------------------
-- Intégrité entre tables (rôle postgres)
-- ---------------------------------------------------------------------------
reset role;
select throws_ok(
  $$ insert into public.question_messages (message_id, question_id)
     select m.id, q.v from public.messages m, ids q
     where m.client_id = (select v from ids where k = 'A') and q.k = 'QB' limit 1 $$,
  '23514', null, 'Intégrité : un message de A ne se rattache pas à une question de B');
select lives_ok(
  $$ select public.record_reminder((select v from ids where k = 'B'), 'pending_items', array[(select v from ids where k = 'QB')], null) $$,
  'Relance : enregistrée');
select is(public.record_reminder((select v from ids where k = 'B'), 'pending_items', null, null), null,
  'Relance : une seule par client et par jour');
select throws_ok(
  $$ insert into public.subscription_plan_periods (subscription_id, plan_code, effective_from,
       recurring_price_cents, included_transactions, extra_transaction_cents, stripe_price_id,
       grid_version, included_accounts, included_filing_frequency, quickbooks_included, extra_account_cents, extra_filing_cents)
     select id, 'elan', '2026-10-15', 14900, 50, 450, 'elan_monthly_2026_10_21', '2026-10-21', 3, 'quarterly', false, 1500, 2500 from public.subscriptions where stripe_subscription_id = 'sub_B' $$,
  '23P01', null, 'Forfaits : deux périodes ne se chevauchent pas');

-- Privilèges des fonctions (y compris celles créées par de futures migrations)
select is(
  (select array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')),
  null, 'Fonctions : aucune exécutable par anon');
select is(
  (select array_agg(n.nspname || '.' || p.proname order by n.nspname || '.' || p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and has_function_privilege('authenticated', p.oid, 'execute')),
  array['private.is_admin', 'private.my_client_ids', 'private.my_open_mandate_ids', 'private.my_writable_client_ids',
        'private.today', 'private.try_uuid', 'public.confirm_document_upload'],
  'Fonctions : seules celles prévues sont exécutables par un utilisateur connecté');
create function public.future_function() returns int language sql as 'select 1';
select ok(not has_function_privilege('anon', 'public.future_function()', 'execute')
      and not has_function_privilege('authenticated', 'public.future_function()', 'execute'),
  'Fonctions : une nouvelle fonction n''est exécutable par personne tant qu''on ne l''accorde pas');

select * from finish();
rollback;
