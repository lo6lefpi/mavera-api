-- =============================================================================
-- Sécurité : privilèges, RLS et stockage des fichiers
--
-- Trois niveaux de protection, du plus large au plus fin :
--   1. Privilèges (GRANT) : par défaut, anon et authenticated n'ont accès à
--      rien. On accorde table par table, et colonne par colonne pour les
--      écritures : un client ne peut jamais fournir lui-même author_id,
--      sent_at, created_by, etc. (les valeurs par défaut s'appliquent).
--   2. RLS : quelles lignes. Un client ne voit que les dossiers dont il est
--      membre; l'administratrice voit tout, seulement avec la double
--      authentification (aal2).
--   3. Aucune politique d'écriture sur ce qui touche l'argent ou un statut
--      (mandats, abonnements, pauses, propositions et leurs réponses, Stripe) :
--      seules les fonctions serveur (rôle service, qui contourne la RLS) y
--      écrivent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Privilèges
-- -----------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

-- Les prochaines migrations partent aussi de « rien » : chaque nouvelle table
-- devra accorder explicitement ses privilèges.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
-- (le défaut global PUBLIC est retiré au début de 01_schema; ceci retire en plus
-- les privilèges que Supabase accorde par schéma à anon et authenticated)
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- RLS sur toutes les tables, même celles sans politique (= aucun accès)
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 2. Fonctions utilisées par les politiques
--    Schéma private : non exposé par l'API. security definer pour éviter que
--    les politiques ne s'appellent en boucle.
-- -----------------------------------------------------------------------------
grant usage on schema private to authenticated;

create function private.is_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()))
     and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
$$;

-- Dossiers dont l'utilisateur est membre
create function private.my_client_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select client_id from public.client_members where user_id = (select auth.uid())
$$;

-- Dossiers où l'utilisateur peut encore envoyer : mandat ouvert et pas en
-- lecture seule (paiement en retard au-delà du délai de grâce).
create function private.my_writable_client_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select m.client_id
  from public.client_members cm
  join public.mandates m on m.client_id = cm.client_id
  where cm.user_id = (select auth.uid())
    and not exists (select 1 from public.mandate_closures c where c.mandate_id = m.id)
    and not exists (
      select 1 from public.subscriptions s
      where s.mandate_id = m.id and s.ended_at is null and s.read_only_since is not null)
$$;

-- Mandats ouverts (non fermés) des dossiers où l'utilisateur peut écrire
create function private.my_open_mandate_ids()
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select m.id from public.mandates m
  where m.client_id in (select private.my_writable_client_ids())
    and not exists (select 1 from public.mandate_closures c where c.mandate_id = m.id)
$$;

grant execute on function private.is_admin(), private.my_client_ids(), private.my_writable_client_ids(),
  private.my_open_mandate_ids() to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Tables de référence : lecture pour tout utilisateur connecté
-- -----------------------------------------------------------------------------
grant select on public.plans, public.add_ons, public.document_types, public.activity_types to authenticated;
create policy "référence : lecture" on public.plans          for select to authenticated using (true);
create policy "référence : lecture" on public.add_ons        for select to authenticated using (true);
create policy "référence : lecture" on public.document_types for select to authenticated using (true);
create policy "référence : lecture" on public.activity_types for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- 4. Personnes et accès
-- -----------------------------------------------------------------------------
grant select on public.admins to authenticated;
create policy "soi-même : savoir si on est administrateur" on public.admins
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.clients to authenticated;
grant update (display_name, contact_email, phone) on public.clients to authenticated;
create policy "client : son dossier" on public.clients
  for select to authenticated using (id in (select private.my_client_ids()));
create policy "admin : lecture" on public.clients
  for select to authenticated using ((select private.is_admin()));
create policy "admin : coordonnées" on public.clients
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant select on public.client_members to authenticated;
create policy "client : membres de son dossier" on public.client_members
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : lecture" on public.client_members
  for select to authenticated using ((select private.is_admin()));

grant select on public.invitations to authenticated;
create policy "admin : lecture" on public.invitations
  for select to authenticated using ((select private.is_admin()));

grant select on public.account_deletion_requests to authenticated;
grant insert (user_id, email, source) on public.account_deletion_requests to authenticated;
create policy "soi-même : ses demandes" on public.account_deletion_requests
  for select to authenticated using (user_id = (select auth.uid()));
create policy "soi-même : demander la suppression de son compte" on public.account_deletion_requests
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and email = lower((select auth.jwt()) ->> 'email')
    and source = 'app');
create policy "admin : lecture" on public.account_deletion_requests
  for select to authenticated using ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- 5. Fiche de départ (une par mandat), comptes et autorisation
-- -----------------------------------------------------------------------------
grant select on public.intake_forms to authenticated;
grant update (activity_type_code, gst_qst_registered, gst_qst_frequency,
              books_up_to_date, uses_quickbooks, current_step) on public.intake_forms to authenticated;
create policy "client : lecture" on public.intake_forms
  for select to authenticated using (mandate_id in (
    select id from public.mandates where client_id in (select private.my_client_ids())));
create policy "client : remplir tant qu'elle n'est pas terminée" on public.intake_forms
  for update to authenticated
  using (mandate_id in (select private.my_open_mandate_ids()) and completed_at is null)
  with check (mandate_id in (select private.my_open_mandate_ids()) and completed_at is null);
create policy "admin : lecture" on public.intake_forms
  for select to authenticated using ((select private.is_admin()));
create policy "admin : correction" on public.intake_forms
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant select, delete on public.client_accounts to authenticated;
grant insert (client_id, kind, institution, nickname) on public.client_accounts to authenticated;
grant update (kind, institution, nickname) on public.client_accounts to authenticated;
create policy "client : lecture" on public.client_accounts
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "client : ajout" on public.client_accounts
  for insert to authenticated with check (client_id in (select private.my_writable_client_ids()));
create policy "client : modification" on public.client_accounts
  for update to authenticated
  using (client_id in (select private.my_writable_client_ids()))
  with check (client_id in (select private.my_writable_client_ids()));
create policy "client : retrait" on public.client_accounts
  for delete to authenticated using (client_id in (select private.my_writable_client_ids()));
create policy "admin : tout" on public.client_accounts
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant select on public.revenue_quebec_authorizations to authenticated;
grant insert (client_id, signer_name) on public.revenue_quebec_authorizations to authenticated;
create policy "client : lecture" on public.revenue_quebec_authorizations
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "client : signer" on public.revenue_quebec_authorizations
  for insert to authenticated with check (
    client_id in (select private.my_writable_client_ids()) and signed_by = (select auth.uid()));
create policy "admin : lecture" on public.revenue_quebec_authorizations
  for select to authenticated using ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- 6. Argent et statuts : lecture seulement (écriture par les fonctions serveur)
--    Mandats, fermetures, abonnements, forfaits, pauses, propositions
-- -----------------------------------------------------------------------------
grant select on public.mandates, public.subscriptions, public.subscription_plan_periods,
                public.subscription_add_ons, public.pauses, public.proposals,
                public.proposal_responses to authenticated;

create policy "client : lecture" on public.mandates
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : lecture" on public.mandates
  for select to authenticated using ((select private.is_admin()));

create policy "client : lecture" on public.subscriptions
  for select to authenticated using (mandate_id in (
    select id from public.mandates where client_id in (select private.my_client_ids())));
create policy "admin : lecture" on public.subscriptions
  for select to authenticated using ((select private.is_admin()));

create policy "client : lecture" on public.subscription_plan_periods
  for select to authenticated using (subscription_id in (
    select s.id from public.subscriptions s join public.mandates m on m.id = s.mandate_id
    where m.client_id in (select private.my_client_ids())));
create policy "admin : lecture" on public.subscription_plan_periods
  for select to authenticated using ((select private.is_admin()));

create policy "client : lecture" on public.subscription_add_ons
  for select to authenticated using (subscription_id in (
    select s.id from public.subscriptions s join public.mandates m on m.id = s.mandate_id
    where m.client_id in (select private.my_client_ids())));
create policy "admin : lecture" on public.subscription_add_ons
  for select to authenticated using ((select private.is_admin()));

grant select on public.mandate_closures to authenticated;
create policy "client : lecture" on public.mandate_closures
  for select to authenticated using (mandate_id in (
    select id from public.mandates where client_id in (select private.my_client_ids())));
create policy "admin : lecture" on public.mandate_closures
  for select to authenticated using ((select private.is_admin()));

grant select on public.closure_lifts to authenticated;
create policy "admin : lecture" on public.closure_lifts
  for select to authenticated using ((select private.is_admin()));

grant select on public.signup_flags, public.signup_reviews to authenticated;
create policy "admin : lecture" on public.signup_flags
  for select to authenticated using ((select private.is_admin()));
create policy "admin : lecture" on public.signup_reviews
  for select to authenticated using ((select private.is_admin()));

create policy "client : lecture" on public.pauses
  for select to authenticated using (mandate_id in (
    select id from public.mandates where client_id in (select private.my_client_ids())));
create policy "admin : lecture" on public.pauses
  for select to authenticated using ((select private.is_admin()));

create policy "client : lecture" on public.proposals
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : lecture" on public.proposals
  for select to authenticated using ((select private.is_admin()));

create policy "client : lecture" on public.proposal_responses
  for select to authenticated using (proposal_id in (
    select id from public.proposals where client_id in (select private.my_client_ids())));
create policy "admin : lecture" on public.proposal_responses
  for select to authenticated using ((select private.is_admin()));

-- stripe_events : aucun privilège, aucune politique.

grant select, delete on public.file_notes to authenticated;
grant insert (client_id, body, visible_to_client) on public.file_notes to authenticated;
grant update (body, visible_to_client) on public.file_notes to authenticated;
create policy "client : notes qui lui sont destinées" on public.file_notes
  for select to authenticated using (client_id in (select private.my_client_ids()) and visible_to_client);
create policy "admin : tout" on public.file_notes
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- 7. Documents
-- -----------------------------------------------------------------------------
grant select, delete on public.documents to authenticated;
grant insert (client_id, direction, document_type_code, title, note) on public.documents to authenticated;
-- sent_at n'est jamais modifiable directement : confirm_document_upload vérifie les fichiers
grant update (document_type_code, title, note, processed_at) on public.documents to authenticated;

-- Un document de la firme n'est visible qu'une fois publié (sent_at). Les envois
-- du client sont visibles dès le brouillon (pour reprendre un envoi).
create policy "client : lecture" on public.documents
  for select to authenticated using (
    client_id in (select private.my_client_ids())
    and (direction = 'from_client' or sent_at is not null));
create policy "client : commencer un envoi" on public.documents
  for insert to authenticated with check (
    client_id in (select private.my_writable_client_ids())
    and direction = 'from_client'
    and uploaded_by = (select auth.uid())
    and sent_at is null);
-- L'envoi se confirme par confirm_document_upload() (vérifie qu'il y a au moins une page)
create policy "client : modifier son brouillon" on public.documents
  for update to authenticated
  using (client_id in (select private.my_writable_client_ids()) and uploaded_by = (select auth.uid()) and sent_at is null)
  with check (client_id in (select private.my_writable_client_ids()) and uploaded_by = (select auth.uid())
              and sent_at is null and processed_at is null);
create policy "client : abandonner son brouillon" on public.documents
  for delete to authenticated
  using (client_id in (select private.my_client_ids()) and uploaded_by = (select auth.uid()) and sent_at is null);
create policy "admin : tout" on public.documents
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant select, delete on public.document_pages to authenticated;
grant insert (document_id, page_number, storage_path, mime_type, size_bytes) on public.document_pages to authenticated;
create policy "client : lecture" on public.document_pages
  for select to authenticated using (document_id in (
    select id from public.documents
    where client_id in (select private.my_client_ids())
      and (direction = 'from_client' or sent_at is not null)));
create policy "client : ajouter une page à son brouillon" on public.document_pages
  for insert to authenticated with check (exists (
    select 1 from public.documents d
    where d.id = document_id
      and d.client_id in (select private.my_writable_client_ids())
      and d.uploaded_by = (select auth.uid())
      and d.sent_at is null
      and storage_path like d.client_id::text || '/' || d.id::text || '/%'));
create policy "client : retirer une page de son brouillon" on public.document_pages
  for delete to authenticated using (exists (
    select 1 from public.documents d
    where d.id = document_id
      and d.client_id in (select private.my_client_ids())
      and d.uploaded_by = (select auth.uid())
      and d.sent_at is null));
create policy "admin : tout" on public.document_pages
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant select on public.document_views to authenticated;
grant insert (document_id) on public.document_views to authenticated;
create policy "soi-même : lecture" on public.document_views
  for select to authenticated using (user_id = (select auth.uid()));
create policy "client : noter l'ouverture" on public.document_views
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and document_id in (select id from public.documents where client_id in (select private.my_client_ids())));
create policy "admin : lecture" on public.document_views
  for select to authenticated using ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- 8. Questions et demandes
-- -----------------------------------------------------------------------------
grant select, delete on public.questions to authenticated;
grant insert (client_id, transaction_on, amount_cents, merchant, prompt, due_on) on public.questions to authenticated;
grant update (transaction_on, amount_cents, merchant, prompt, due_on, resolved_at) on public.questions to authenticated;
create policy "client : lecture" on public.questions
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : tout" on public.questions
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant select on public.question_answers to authenticated;
grant insert (question_id, kind, body, document_id) on public.question_answers to authenticated;
grant update (kind, body, document_id) on public.question_answers to authenticated;
create policy "client : lecture" on public.question_answers
  for select to authenticated using (question_id in (
    select id from public.questions where client_id in (select private.my_client_ids())));
create policy "client : répondre" on public.question_answers
  for insert to authenticated with check (
    answered_by = (select auth.uid())
    and question_id in (
      select id from public.questions
      where client_id in (select private.my_writable_client_ids()) and resolved_at is null));
create policy "client : corriger sa réponse avant la résolution" on public.question_answers
  for update to authenticated
  using (question_id in (
    select id from public.questions
    where client_id in (select private.my_writable_client_ids()) and resolved_at is null))
  with check (question_id in (
    select id from public.questions
    where client_id in (select private.my_writable_client_ids()) and resolved_at is null));
create policy "admin : lecture" on public.question_answers
  for select to authenticated using ((select private.is_admin()));

grant select, delete on public.document_requests to authenticated;
grant insert (client_id, document_type_code, title, details, due_on) on public.document_requests to authenticated;
grant update (document_type_code, title, details, due_on, processed_at, canceled_at) on public.document_requests to authenticated;
create policy "client : lecture" on public.document_requests
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : tout" on public.document_requests
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant select, delete on public.request_documents to authenticated;
grant insert (document_id, request_id) on public.request_documents to authenticated;
create policy "client : lecture" on public.request_documents
  for select to authenticated using (request_id in (
    select id from public.document_requests where client_id in (select private.my_client_ids())));
create policy "client : déposer dans une demande ouverte" on public.request_documents
  for insert to authenticated with check (
    document_id in (
      select id from public.documents
      where client_id in (select private.my_writable_client_ids())
        and uploaded_by = (select auth.uid()) and sent_at is null)
    and request_id in (
      select id from public.document_requests
      where client_id in (select private.my_writable_client_ids())
        and processed_at is null and canceled_at is null));
create policy "admin : tout" on public.request_documents
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- 9. Messages
-- -----------------------------------------------------------------------------
grant select on public.messages to authenticated;
grant insert (client_id, body) on public.messages to authenticated;
create policy "client : lecture" on public.messages
  for select to authenticated using (client_id in (select private.my_client_ids()));
-- Les messages restent permis en lecture seule : le client doit pouvoir parler
-- d'un paiement en retard.
create policy "client : écrire" on public.messages
  for insert to authenticated with check (
    client_id in (select private.my_client_ids()) and author_id = (select auth.uid()));
create policy "admin : lecture" on public.messages
  for select to authenticated using ((select private.is_admin()));
create policy "admin : écrire" on public.messages
  for insert to authenticated with check ((select private.is_admin()) and author_id = (select auth.uid()));

grant select, insert on public.question_messages, public.request_messages to authenticated;
create policy "client : lecture" on public.question_messages
  for select to authenticated using (message_id in (
    select id from public.messages where client_id in (select private.my_client_ids())));
create policy "auteur : rattacher son message" on public.question_messages
  for insert to authenticated with check (message_id in (
    select id from public.messages where author_id = (select auth.uid())));
create policy "admin : lecture" on public.question_messages
  for select to authenticated using ((select private.is_admin()));

create policy "client : lecture" on public.request_messages
  for select to authenticated using (message_id in (
    select id from public.messages where client_id in (select private.my_client_ids())));
create policy "auteur : rattacher son message" on public.request_messages
  for insert to authenticated with check (message_id in (
    select id from public.messages where author_id = (select auth.uid())));
create policy "admin : lecture" on public.request_messages
  for select to authenticated using ((select private.is_admin()));

grant select on public.message_reads to authenticated;
grant insert (message_id) on public.message_reads to authenticated;
create policy "soi-même : lecture" on public.message_reads
  for select to authenticated using (user_id = (select auth.uid()));
create policy "soi-même : marquer comme lu" on public.message_reads
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and message_id in (select id from public.messages
                       where client_id in (select private.my_client_ids()) or (select private.is_admin())));

-- -----------------------------------------------------------------------------
-- 10. Notifications, appareils, relances, journal
-- -----------------------------------------------------------------------------
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
create policy "soi-même : lecture" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy "soi-même : marquer comme lue" on public.notifications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, delete on public.push_devices to authenticated;
grant insert (token, platform) on public.push_devices to authenticated;
grant update (last_seen_at) on public.push_devices to authenticated;
create policy "soi-même : ses appareils" on public.push_devices
  for select to authenticated using (user_id = (select auth.uid()));
create policy "soi-même : inscrire un appareil" on public.push_devices
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "soi-même : signaler l'appareil" on public.push_devices
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "soi-même : retirer un appareil" on public.push_devices
  for delete to authenticated using (user_id = (select auth.uid()));

grant select on public.reminders, public.reminder_questions, public.reminder_requests, public.access_log to authenticated;
create policy "admin : lecture" on public.reminders          for select to authenticated using ((select private.is_admin()));
create policy "admin : lecture" on public.reminder_questions for select to authenticated using ((select private.is_admin()));
create policy "admin : lecture" on public.reminder_requests  for select to authenticated using ((select private.is_admin()));
create policy "admin : lecture" on public.access_log         for select to authenticated using ((select private.is_admin()));

grant select, insert, update on public.client_settings to authenticated;
create policy "admin : tout" on public.client_settings
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- 11. Stockage des fichiers (compartiment privé « documents »)
--     Chemin : {client_id}/{document_id}/{page}.{ext}
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520,
        array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf'])
on conflict (id) do nothing;

create function private.try_uuid(p text)
returns uuid language plpgsql immutable set search_path = ''
as $$
begin
  return p::uuid;
exception when invalid_text_representation then
  return null;
end
$$;
grant execute on function private.try_uuid(text) to authenticated;

-- Même règle que les documents : un fichier de la firme n'est lisible qu'une fois publié.
create policy "documents : lecture client" on storage.objects
  for select to authenticated using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.documents d
      where d.id = private.try_uuid((storage.foldername(name))[2])
        and d.client_id = private.try_uuid((storage.foldername(name))[1])
        and d.client_id in (select private.my_client_ids())
        and (d.direction = 'from_client' or d.sent_at is not null)));

create policy "documents : envoi client dans son brouillon" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'documents'
    and exists (
      select 1 from public.documents d
      where d.id = private.try_uuid((storage.foldername(name))[2])
        and d.client_id = private.try_uuid((storage.foldername(name))[1])
        and d.client_id in (select private.my_writable_client_ids())
        and d.uploaded_by = (select auth.uid())
        and d.sent_at is null));

create policy "documents : retrait client dans son brouillon" on storage.objects
  for delete to authenticated using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.documents d
      where d.id = private.try_uuid((storage.foldername(name))[2])
        and d.client_id = private.try_uuid((storage.foldername(name))[1])
        and d.uploaded_by = (select auth.uid())
        and d.sent_at is null));

create policy "documents : admin" on storage.objects
  for all to authenticated
  using (bucket_id = 'documents' and (select private.is_admin()))
  with check (bucket_id = 'documents' and (select private.is_admin()));
