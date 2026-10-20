-- =============================================================================
-- Opérations atomiques (fonctions PostgreSQL)
--
-- Le client JavaScript des Edge Functions ne fait pas de transaction sur
-- plusieurs requêtes : ce qui doit réussir ou échouer d'un bloc est ici.
-- Ces fonctions n'ont AUCUNE règle commerciale (prix, délais, choix du
-- forfait) : elles reçoivent des décisions déjà prises par domain/ et les
-- enregistrent de façon cohérente.
--
-- Accès : rôle service seulement (fonctions serveur), sauf
-- confirm_document_upload, appelée directement par l'application.
-- =============================================================================

-- Idempotence Stripe : true si l'événement est nouveau, false s'il a déjà été reçu
create function public.record_stripe_event(p_event_id text, p_type text)
returns boolean language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.stripe_events (id, type) values (p_event_id, p_type)
  on conflict (id) do nothing;
  return found;
end
$$;

-- Téléphone réduit à ses 10 chiffres (« (514) 555-0123 », « +1 514 555 0123 » → 5145550123)
create function private.normalize_phone(p_phone text)
returns text language sql immutable set search_path = ''
as $$
  select nullif(right(pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 10), '')
$$;
create index clients_phone_normalized_idx on public.clients (private.normalize_phone(phone));

-- Dossiers associés à une adresse courriel : coordonnée du dossier ou compte d'un membre.
-- Sert à reconnaître un ancien client (réouverture).
create function private.clients_for_email(p_email text)
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select id from public.clients where contact_email = lower(p_email)
  union
  select cm.client_id
  from public.client_members cm join auth.users u on u.id = cm.user_id
  where lower(u.email) = lower(p_email)
$$;

-- Clients fermés définitivement (sans annulation)
create function private.is_permanently_closed(p_client uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.mandates m
    join public.mandate_closures c on c.mandate_id = m.id
    where m.client_id = p_client and c.kind = 'permanent'
      and not exists (select 1 from public.closure_lifts l where l.mandate_id = c.mandate_id))
$$;

-- Même personne à coup sûr : même courriel ou même client Stripe (jamais réattribués)
create function private.clients_same_identity(p_email text, p_stripe_customer_id text)
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select private.clients_for_email(p_email)
  union
  select id from public.clients
  where p_stripe_customer_id is not null and stripe_customer_id = p_stripe_customer_id
$$;

-- Clients fermés définitivement dont le téléphone correspond : seulement un indice,
-- car un numéro abandonné peut être réattribué à quelqu'un d'autre.
create function private.refused_clients_for_phone(p_phone text)
returns setof uuid language sql stable security definer set search_path = ''
as $$
  select id from public.clients
  where private.normalize_phone(p_phone) is not null
    and private.normalize_phone(phone) = private.normalize_phone(p_phone)
    and private.is_permanently_closed(id)
$$;

-- À appeler par public-api AVANT de créer la session de paiement Stripe
-- (avec le courriel et le téléphone saisis sur le site; client Stripe s'il est connu).
--   new       : nouveau client
--   returning : ancien client fermé temporairement → réouverture (nouveaux frais d'ouverture)
--   review    : accepté, mais le téléphone est celui d'un client fermé définitivement →
--               vérification à l'appel de bienvenue
--   active    : déjà un mandat ouvert → pas de deuxième inscription
--   refused   : fermé définitivement, sans annulation (même courriel ou même client Stripe)
create function public.check_signup_eligibility(
  p_email text, p_phone text default null, p_stripe_customer_id text default null)
returns text language sql stable security definer set search_path = ''
as $$
  select case
    when exists (select 1 from private.clients_same_identity(p_email, p_stripe_customer_id) c
                 where private.is_permanently_closed(c))
      then 'refused'
    when exists (
      select 1 from public.mandates m
      where m.client_id in (select private.clients_for_email(p_email))
        and not exists (select 1 from public.mandate_closures c where c.mandate_id = m.id))
      then 'active'
    when exists (select 1 from private.refused_clients_for_phone(p_phone))
      then 'review'
    when exists (select 1 from private.clients_for_email(p_email))
      then 'returning'
    else 'new'
  end
$$;

-- Paiement confirmé par Stripe : fiche, mandat, abonnement, forfait et
-- invitation, d'un seul bloc. Nouveau client ou réouverture d'un ancien.
-- Retourne null si l'événement a déjà été traité.
-- Erreurs (filet de sécurité si public-api n'a pas bloqué avant le paiement) :
--   P0003 client fermé définitivement (même courriel ou client Stripe), P0004 mandat déjà ouvert.
-- Même téléphone seulement : le dossier est créé avec une alerte (signup_flags).
--   stripe-webhook rembourse alors, puis appelle record_stripe_event.
create function public.handle_checkout_completed(
  p_event_id               text,
  p_email                  text,
  p_display_name           text,
  p_plan_code              text,
  p_billing_option         public.billing_option,
  p_starts_on              date,
  p_stripe_customer_id     text,
  p_stripe_subscription_id text,
  p_stripe_status          text,
  p_books_up_to_date       boolean,
  p_uses_quickbooks        boolean,
  p_estimated_transactions integer,
  p_invitation_expires_at  timestamptz,
  -- Conditions accordées, calculées par domain/pricing (photographie contractuelle)
  p_recurring_price_cents   integer,
  p_included_transactions   integer,
  p_extra_transaction_cents integer,
  p_opening_fee_cents       integer,
  p_stripe_price_id         text,
  p_phone                   text default null
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_status  text;
  v_client  uuid;
  v_mandate uuid;
  v_sub     uuid;
begin
  if not public.record_stripe_event(p_event_id, 'checkout.session.completed') then
    return null;
  end if;

  v_status := public.check_signup_eligibility(p_email, p_phone, p_stripe_customer_id);
  if v_status = 'refused' then
    raise exception 'Client fermé définitivement : paiement à rembourser' using errcode = 'P0003';
  elsif v_status = 'active' then
    raise exception 'Mandat déjà ouvert : paiement à rembourser' using errcode = 'P0004';
  end if;

  if exists (select 1 from private.clients_for_email(p_email)) then
    select c.id into v_client
    from public.clients c
    where c.id in (select private.clients_for_email(p_email))
    order by c.created_at desc
    limit 1;
    update public.clients
       set stripe_customer_id = coalesce(stripe_customer_id, p_stripe_customer_id),
           phone              = coalesce(phone, p_phone)
     where id = v_client;
  else
    insert into public.clients (display_name, contact_email, phone, stripe_customer_id)
    values (p_display_name, lower(p_email), p_phone, p_stripe_customer_id)
    returning id into v_client;
  end if;

  insert into public.client_settings (client_id) values (v_client)
  on conflict (client_id) do nothing;

  insert into public.mandates (client_id) values (v_client) returning id into v_mandate;

  -- Nouvelle fiche pour ce mandat. Réouverture : préremplie avec la fiche précédente
  -- (activité, TPS/TVQ), que le client confirme ou corrige; les réponses du site priment.
  insert into public.intake_forms (mandate_id, activity_type_code, gst_qst_registered, gst_qst_frequency,
                                   books_up_to_date, uses_quickbooks, estimated_monthly_transactions)
  select v_mandate, prev.activity_type_code, prev.gst_qst_registered, prev.gst_qst_frequency,
         p_books_up_to_date, p_uses_quickbooks, p_estimated_transactions
  from (select 1) as one
  left join lateral (
    select f.activity_type_code, f.gst_qst_registered, f.gst_qst_frequency
    from public.intake_forms f join public.mandates m on m.id = f.mandate_id
    where m.client_id = v_client and m.id <> v_mandate
    order by m.opened_at desc
    limit 1
  ) prev on true;

  insert into public.subscriptions (mandate_id, stripe_subscription_id, billing_option, starts_on,
                                    opening_fee_cents, stripe_status)
  values (v_mandate, p_stripe_subscription_id, p_billing_option, p_starts_on,
          p_opening_fee_cents, p_stripe_status)
  returning id into v_sub;

  -- Téléphone d'un client fermé définitivement : inscription acceptée, à vérifier
  insert into public.signup_flags (mandate_id, matched_client_id)
  select v_mandate, r from private.refused_clients_for_phone(p_phone) r
  where r <> v_client;

  insert into public.subscription_plan_periods (subscription_id, plan_code, effective_from,
    recurring_price_cents, included_transactions, extra_transaction_cents, stripe_price_id)
  values (v_sub, p_plan_code, p_starts_on,
    p_recurring_price_cents, p_included_transactions, p_extra_transaction_cents, p_stripe_price_id);

  -- Réouverture : le client garde son compte, pas de nouvelle invitation
  if not exists (select 1 from public.client_members where client_id = v_client) then
    insert into public.invitations (client_id, email, expires_at)
    values (v_client, lower(p_email), p_invitation_expires_at)
    on conflict do nothing;
  end if;

  update public.stripe_events set processed_at = now() where id = p_event_id;
  return v_client;
end
$$;

-- Invitation acceptée : le compte devient membre du dossier
create function public.accept_invitation(p_invitation uuid, p_user uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
begin
  select * into v_inv from public.invitations where id = p_invitation for update;
  if not found or v_inv.accepted_at is not null or v_inv.expires_at <= now() then
    raise exception 'Invitation invalide ou expirée' using errcode = 'P0002';
  end if;
  if (select lower(email) from auth.users where id = p_user) is distinct from v_inv.email then
    raise exception 'Cette invitation est destinée à une autre adresse' using errcode = '42501';
  end if;

  update public.invitations set accepted_at = now(), accepted_by = p_user where id = p_invitation;

  insert into public.client_members (client_id, user_id, role)
  values (v_inv.client_id, p_user,
          case when exists (select 1 from public.client_members
                            where client_id = v_inv.client_id and role = 'owner')
               then 'collaborator'::public.member_role else 'owner'::public.member_role end)
  on conflict (client_id, user_id) do nothing;

  return v_inv.client_id;
end
$$;

-- Fiche de départ terminée + premières demandes (choisies par domain/activation)
-- p_requests : [{"document_type_code": "bank_statement", "title": "…", "details": "…", "due_on": "2026-11-05"}]
create function public.complete_intake_form(p_mandate uuid, p_user uuid, p_requests jsonb)
returns integer language plpgsql security definer set search_path = ''
as $$
declare
  v_client uuid;
  v_count  integer;
begin
  select client_id into v_client from public.mandates where id = p_mandate;
  if not exists (select 1 from public.client_members where client_id = v_client and user_id = p_user) then
    raise exception 'Accès refusé' using errcode = '42501';
  end if;
  if exists (select 1 from public.mandate_closures where mandate_id = p_mandate) then
    raise exception 'Mandat fermé' using errcode = 'P0001';
  end if;

  update public.intake_forms set completed_at = now()
  where mandate_id = p_mandate and completed_at is null;
  if not found then
    raise exception 'Fiche introuvable ou déjà terminée' using errcode = 'P0002';
  end if;

  insert into public.document_requests (client_id, document_type_code, title, details, due_on, created_by)
  select v_client, r.document_type_code, r.title, r.details, r.due_on, null
  from jsonb_to_recordset(coalesce(p_requests, '[]'::jsonb))
       as r(document_type_code text, title text, details text, due_on date);
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- Réponse du client à une proposition (le paiement éventuel est fait par client-api)
create function public.record_proposal_response(p_proposal uuid, p_user uuid, p_decision public.proposal_decision)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_client  uuid;
  v_expires timestamptz;
begin
  select client_id, expires_at into v_client, v_expires
  from public.proposals where id = p_proposal for update;
  if not found then
    raise exception 'Proposition introuvable' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.client_members where client_id = v_client and user_id = p_user) then
    raise exception 'Accès refusé' using errcode = '42501';
  end if;
  if v_expires is not null and v_expires <= now() then
    raise exception 'Proposition expirée' using errcode = 'P0001';
  end if;

  insert into public.proposal_responses (proposal_id, decision, responded_by)
  values (p_proposal, p_decision, p_user);  -- une deuxième réponse viole la clé primaire
end
$$;

-- Changement de forfait : ferme la période en cours et ouvre la suivante
-- (la date est décidée par domain/subscriptions : aujourd'hui pour une hausse,
-- le 1er du mois suivant pour une baisse)
-- Les conditions du nouveau forfait (prix, quota, transaction supplémentaire) viennent
-- de domain/pricing et sont photographiées sur la nouvelle période.
create function public.change_plan(
  p_subscription            uuid,
  p_plan_code               text,
  p_effective_from          date,
  p_recurring_price_cents   integer,
  p_included_transactions   integer,
  p_extra_transaction_cents integer,
  p_stripe_price_id         text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  -- un changement déjà prévu à une date ultérieure est remplacé
  delete from public.subscription_plan_periods
   where subscription_id = p_subscription and effective_from >= p_effective_from;

  update public.subscription_plan_periods
     set effective_to = p_effective_from
   where subscription_id = p_subscription
     and effective_from < p_effective_from
     and (effective_to is null or effective_to > p_effective_from);

  insert into public.subscription_plan_periods (subscription_id, plan_code, effective_from,
    recurring_price_cents, included_transactions, extra_transaction_cents, stripe_price_id)
  values (p_subscription, p_plan_code, p_effective_from,
    p_recurring_price_cents, p_included_transactions, p_extra_transaction_cents, p_stripe_price_id);
end
$$;

-- Pause, reprise et fermeture d'un dossier sans réponse
create function public.pause_mandate(p_mandate uuid, p_skipped_charge_on date)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_pause uuid;
begin
  if exists (select 1 from public.mandate_closures where mandate_id = p_mandate) then
    raise exception 'Mandat fermé' using errcode = 'P0001';
  end if;
  insert into public.pauses (mandate_id, skipped_charge_on)
  values (p_mandate, p_skipped_charge_on)
  returning id into v_pause;  -- une deuxième pause ouverte viole pauses_one_open
  return v_pause;
end
$$;

create function public.resume_mandate(p_mandate uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  update public.pauses set ended_at = now(), outcome = 'resumed'
  where mandate_id = p_mandate and ended_at is null;
  if not found then
    raise exception 'Aucune pause en cours' using errcode = 'P0002';
  end if;
end
$$;

-- Fermeture temporaire (le client peut revenir) ou définitive (il n'est plus accepté).
-- Le choix vient de la teneuse de livres (admin-api) ou de la règle « sans réponse
-- après 30 jours » (scheduled-jobs, toujours temporaire).
create function public.close_mandate(
  p_mandate         uuid,
  p_kind            public.closure_kind,
  p_reason          public.close_reason,
  p_retention_until date,
  p_closed_by       uuid default null
)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  update public.pauses set ended_at = now(), outcome = 'closed'
  where mandate_id = p_mandate and ended_at is null;

  insert into public.mandate_closures (mandate_id, kind, reason, retention_until, closed_by)
  values (p_mandate, p_kind, p_reason, p_retention_until, p_closed_by);
  -- un mandat déjà fermé viole la clé primaire
end
$$;

-- Annulation d'une fermeture définitive (admin-api). Le client peut se réinscrire.
create function public.lift_permanent_closure(p_mandate uuid, p_reason text, p_lifted_by uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.mandate_closures where mandate_id = p_mandate) then
    raise exception 'Ce mandat n''est pas fermé' using errcode = 'P0002';
  end if;
  insert into public.closure_lifts (mandate_id, reason, lifted_by)
  values (p_mandate, p_reason, p_lifted_by);  -- une deuxième annulation viole la clé primaire
end
$$;

-- Décision sur une inscription à vérifier (admin-api, après l'appel de bienvenue).
-- same_person : le mandat est fermé définitivement; admin-api rembourse au complet.
create function public.review_signup(
  p_mandate uuid, p_outcome public.review_outcome, p_reviewed_by uuid, p_retention_until date default null)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.signup_reviews (mandate_id, outcome, reviewed_by)
  values (p_mandate, p_outcome, p_reviewed_by);  -- une seule décision par mandat

  if p_outcome = 'same_person' then
    if p_retention_until is null then
      raise exception 'Date de fin de conservation requise' using errcode = 'P0001';
    end if;
    perform public.close_mandate(p_mandate, 'permanent', 'previously_refused', p_retention_until, p_reviewed_by);
  end if;
end
$$;

-- Rappel groupé du jour : un seul par client et par jour (index unique).
-- Retourne null si un rappel est déjà parti aujourd'hui.
create function public.record_reminder(
  p_client uuid, p_reason public.reminder_reason, p_question_ids uuid[], p_request_ids uuid[])
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_reminder uuid;
begin
  insert into public.reminders (client_id, reason) values (p_client, p_reason)
  on conflict do nothing
  returning id into v_reminder;
  if v_reminder is null then
    return null;
  end if;

  insert into public.reminder_questions (reminder_id, question_id)
  select v_reminder, unnest(coalesce(p_question_ids, '{}'));
  insert into public.reminder_requests (reminder_id, request_id)
  select v_reminder, unnest(coalesce(p_request_ids, '{}'));
  return v_reminder;
end
$$;

-- Appelée par l'application : confirme un envoi (au moins une page)
create function public.confirm_document_upload(p_document uuid)
returns timestamptz language plpgsql security definer set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
  v_now timestamptz := now();
begin
  select * into v_doc from public.documents where id = p_document for update;
  if not found then
    raise exception 'Document introuvable' using errcode = 'P0002';
  end if;

  if v_doc.direction = 'from_client' then
    if v_doc.uploaded_by is distinct from auth.uid()
       or v_doc.client_id not in (select private.my_writable_client_ids()) then
      raise exception 'Accès refusé' using errcode = '42501';
    end if;
  elsif not private.is_admin() then
    raise exception 'Accès refusé' using errcode = '42501';
  end if;

  if v_doc.sent_at is not null then
    return v_doc.sent_at;  -- déjà envoyé : on ne refait rien
  end if;
  if not exists (select 1 from public.document_pages where document_id = p_document) then
    raise exception 'Le document n''a aucune page' using errcode = 'P0001';
  end if;
  -- Chaque page doit correspondre à un fichier réellement téléversé, à la bonne taille
  if exists (
    select 1 from public.document_pages p
    where p.document_id = p_document
      and not exists (
        select 1 from storage.objects o
        where o.bucket_id = 'documents'
          and o.name = p.storage_path
          and coalesce((o.metadata ->> 'size')::bigint, p.size_bytes) = p.size_bytes)) then
    raise exception 'Fichier manquant ou incomplet : téléversement à reprendre' using errcode = 'P0001';
  end if;

  update public.documents set sent_at = v_now where id = p_document;
  insert into public.access_log (user_id, client_id, action, object_table, object_id)
  values (auth.uid(), v_doc.client_id, 'document.sent', 'documents', p_document);
  return v_now;
end
$$;

-- Privilèges : rôle service seulement, sauf confirm_document_upload
revoke execute on function
  public.check_signup_eligibility(text, text, text),
  public.record_stripe_event(text, text),
  public.handle_checkout_completed(text, text, text, text, public.billing_option, date, text, text, text, boolean, boolean, integer, timestamptz, integer, integer, integer, integer, text, text),
  public.accept_invitation(uuid, uuid),
  public.complete_intake_form(uuid, uuid, jsonb),
  public.record_proposal_response(uuid, uuid, public.proposal_decision),
  public.change_plan(uuid, text, date, integer, integer, integer, text),
  public.pause_mandate(uuid, date),
  public.resume_mandate(uuid),
  public.close_mandate(uuid, public.closure_kind, public.close_reason, date, uuid),
  public.lift_permanent_closure(uuid, text, uuid),
  public.review_signup(uuid, public.review_outcome, uuid, date),
  public.record_reminder(uuid, public.reminder_reason, uuid[], uuid[]),
  public.confirm_document_upload(uuid)
from public, anon, authenticated;

grant execute on function
  public.check_signup_eligibility(text, text, text),
  public.record_stripe_event(text, text),
  public.handle_checkout_completed(text, text, text, text, public.billing_option, date, text, text, text, boolean, boolean, integer, timestamptz, integer, integer, integer, integer, text, text),
  public.accept_invitation(uuid, uuid),
  public.complete_intake_form(uuid, uuid, jsonb),
  public.record_proposal_response(uuid, uuid, public.proposal_decision),
  public.change_plan(uuid, text, date, integer, integer, integer, text),
  public.pause_mandate(uuid, date),
  public.resume_mandate(uuid),
  public.close_mandate(uuid, public.closure_kind, public.close_reason, date, uuid),
  public.lift_permanent_closure(uuid, text, uuid),
  public.review_signup(uuid, public.review_outcome, uuid, date),
  public.record_reminder(uuid, public.reminder_reason, uuid[], uuid[])
to service_role;

grant execute on function public.confirm_document_upload(uuid) to authenticated;
