-- =============================================================================
-- Intégrité entre tables
--
-- Les tables d'association (document ↔ demande, message ↔ question, etc.) ne
-- recopient pas client_id, pour rester en FNBC. La règle « les deux côtés
-- appartiennent au même client » est donc une contrainte entre tables,
-- vérifiée ici par des déclencheurs.
-- =============================================================================

create schema if not exists private;
revoke all on schema private from public;

-- Le client d'un objet, quelle que soit la RLS (lecture interne seulement)
create function private.client_of(p_table text, p_id uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_client uuid;
begin
  case p_table
    when 'documents'         then select client_id into v_client from public.documents         where id = p_id;
    when 'document_requests' then select client_id into v_client from public.document_requests where id = p_id;
    when 'questions'         then select client_id into v_client from public.questions         where id = p_id;
    when 'messages'          then select client_id into v_client from public.messages          where id = p_id;
    when 'reminders'         then select client_id into v_client from public.reminders         where id = p_id;
    else raise exception 'client_of : table inconnue %', p_table;
  end case;
  return v_client;
end
$$;

create function private.assert_same_client(p_left_table text, p_left uuid, p_right_table text, p_right uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if private.client_of(p_left_table, p_left) is distinct from private.client_of(p_right_table, p_right) then
    raise exception 'Les deux éléments n''appartiennent pas au même client'
      using errcode = 'check_violation';
  end if;
end
$$;

-- Document déposé dans une demande -------------------------------------------
create function private.check_request_document()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_same_client('documents', new.document_id, 'document_requests', new.request_id);
  if (select direction from public.documents where id = new.document_id) <> 'from_client' then
    raise exception 'Seul un document envoyé par le client peut répondre à une demande'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger request_documents_same_client
  before insert or update on public.request_documents
  for each row execute function private.check_request_document();

-- Photo du reçu en réponse à une question ------------------------------------
create function private.check_question_answer()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.document_id is not null then
    perform private.assert_same_client('documents', new.document_id, 'questions', new.question_id);
    if not exists (select 1 from public.documents
                   where id = new.document_id and direction = 'from_client' and sent_at is not null) then
      raise exception 'Le reçu doit être un document envoyé (téléversement confirmé)'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
create trigger question_answers_same_client
  before insert or update on public.question_answers
  for each row execute function private.check_question_answer();

-- Message rattaché à une question ou à une demande ----------------------------
create function private.check_message_context()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'question_messages' then
    perform private.assert_same_client('messages', new.message_id, 'questions', new.question_id);
    if exists (select 1 from public.request_messages where message_id = new.message_id) then
      raise exception 'Un message est rattaché à un seul contexte' using errcode = 'check_violation';
    end if;
  else
    perform private.assert_same_client('messages', new.message_id, 'document_requests', new.request_id);
    if exists (select 1 from public.question_messages where message_id = new.message_id) then
      raise exception 'Un message est rattaché à un seul contexte' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
create trigger question_messages_same_client
  before insert or update on public.question_messages
  for each row execute function private.check_message_context();
create trigger request_messages_same_client
  before insert or update on public.request_messages
  for each row execute function private.check_message_context();

-- Éléments regroupés dans un rappel -------------------------------------------
create function private.check_reminder_item()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'reminder_questions' then
    perform private.assert_same_client('reminders', new.reminder_id, 'questions', new.question_id);
  else
    perform private.assert_same_client('reminders', new.reminder_id, 'document_requests', new.request_id);
  end if;
  return new;
end
$$;
create trigger reminder_questions_same_client
  before insert or update on public.reminder_questions
  for each row execute function private.check_reminder_item();
create trigger reminder_requests_same_client
  before insert or update on public.reminder_requests
  for each row execute function private.check_reminder_item();

-- Type de document permis au client --------------------------------------------
create function private.check_document_type()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.direction = 'from_client'
     and not (select sendable_by_client from public.document_types where code = new.document_type_code) then
    raise exception 'Ce type de document est réservé à la firme' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger documents_type_allowed
  before insert or update of direction, document_type_code on public.documents
  for each row execute function private.check_document_type();

-- Pages figées une fois le document envoyé -------------------------------------
-- Exception : le rôle service (fonctions serveur) peut retirer les pages, par
-- exemple après le transfert dans QuickBooks (P2) ou à la destruction.
create function private.check_document_draft()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_doc uuid := coalesce(new.document_id, old.document_id);
begin
  if (select sent_at from public.documents where id = v_doc) is not null then
    raise exception 'Le document est déjà envoyé : ses pages ne changent plus'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end
$$;
create trigger document_pages_draft_only
  before insert or update or delete on public.document_pages
  for each row
  when (current_user <> 'service_role')
  execute function private.check_document_draft();

-- Un objet ne change jamais de client -------------------------------------------
create function private.forbid_client_change()
returns trigger language plpgsql
as $$
begin
  raise exception 'client_id ne peut pas être modifié (%)', tg_table_name using errcode = 'check_violation';
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'client_members', 'invitations', 'client_accounts', 'revenue_quebec_authorizations',
    'mandates', 'proposals', 'file_notes', 'documents', 'questions', 'document_requests',
    'messages', 'reminders', 'client_settings'
  ] loop
    execute format(
      'create trigger %I before update of client_id on public.%I
         for each row when (old.client_id is distinct from new.client_id)
         execute function private.forbid_client_change()',
      t || '_client_immutable', t);
  end loop;
end
$$;

-- Mandats : un seul ouvert par client, aucun pour un client fermé définitivement
-- (la fermeture est dans une autre table : un index partiel ne suffit plus)
create function private.check_new_mandate()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  -- verrou sur le client : deux ouvertures simultanées ne passent pas toutes les deux
  perform 1 from public.clients where id = new.client_id for update;

  if exists (
    select 1 from public.mandates m
    join public.mandate_closures c on c.mandate_id = m.id
    where m.client_id = new.client_id and c.kind = 'permanent'
      and not exists (select 1 from public.closure_lifts l where l.mandate_id = c.mandate_id)) then
    raise exception 'Ce client a été fermé définitivement' using errcode = 'P0003';
  end if;

  if exists (
    select 1 from public.mandates m
    where m.client_id = new.client_id
      and not exists (select 1 from public.mandate_closures c where c.mandate_id = m.id)) then
    raise exception 'Ce client a déjà un mandat ouvert' using errcode = 'P0004';
  end if;
  return new;
end
$$;
create trigger mandates_one_open
  before insert on public.mandates
  for each row execute function private.check_new_mandate();

create function private.check_mandate_closure()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.closed_at < (select opened_at from public.mandates where id = new.mandate_id) then
    raise exception 'Une fermeture ne peut pas précéder l''ouverture' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger mandate_closures_after_opening
  before insert or update on public.mandate_closures
  for each row execute function private.check_mandate_closure();

create function private.check_closure_lift()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_closure public.mandate_closures%rowtype;
begin
  select * into v_closure from public.mandate_closures where mandate_id = new.mandate_id;
  if v_closure.kind <> 'permanent' then
    raise exception 'Seule une fermeture définitive s''annule' using errcode = 'check_violation';
  end if;
  if new.lifted_at < v_closure.closed_at then
    raise exception 'L''annulation ne peut pas précéder la fermeture' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger closure_lifts_permanent_only
  before insert or update on public.closure_lifts
  for each row execute function private.check_closure_lift();

-- Inscription à vérifier : décision seulement s'il y a une alerte, activation seulement après la décision
create function private.check_signup_review()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.signup_flags where mandate_id = new.mandate_id) then
    raise exception 'Aucune vérification demandée pour ce mandat' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger signup_reviews_need_flag
  before insert or update on public.signup_reviews
  for each row execute function private.check_signup_review();

create function private.check_activation_allowed()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.signup_flags where mandate_id = new.id)
     and not exists (select 1 from public.signup_reviews
                     where mandate_id = new.id and outcome = 'different_person') then
    raise exception 'Vérification d''identité à faire avant l''activation' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger mandates_activation_after_review
  before update of activated_at on public.mandates
  for each row when (new.activated_at is not null and old.activated_at is null)
  execute function private.check_activation_allowed();
