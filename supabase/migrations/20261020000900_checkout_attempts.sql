-- =============================================================================
-- Tentatives d'inscription payées par Stripe
--
-- Une tentative est une fiche temporaire : elle garde le récapitulatif calculé
-- par domain/pricing (quoteCheckout) au moment où le client a vu son prix.
-- Le webhook ne recalcule jamais rien : il relit la tentative et crée le
-- dossier client avec ces conditions. Le dossier garde ensuite tout ce qui
-- compte; la tentative est purgée après 30 ou 90 jours (Loi 25).
--
-- États : créée → session Stripe → payée → abonnement créé → terminée,
-- ou refusée (remboursée), ou abandonnée (jamais payée).
--
-- Règles de sécurité :
-- - un ancien client ne se réinscrit pas par le site (il passe par l'application,
--   où il est authentifié) : aucune réouverture sur la seule foi d'un courriel;
-- - une seule tentative ouverte par courriel;
-- - un refus n'est enregistré qu'avec un remboursement du montant payé.
--
-- Aucune règle tarifaire n'est calculée en SQL; la cohérence du récapitulatif
-- est seulement vérifiée. Écritures : rôle service seulement.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Récapitulatif complet ET cohérent, vérifié avant le paiement
-- -----------------------------------------------------------------------------
create function private.is_valid_checkout_quote(q jsonb)
returns boolean language plpgsql immutable set search_path = ''
as $$
declare
  t            jsonb := q -> 'terms';
  v_plan       text;
  v_billing    text;
  v_cycle      text;
  v_recurring  integer;
  v_opening    integer;
  v_total      integer;
  v_sum        integer;
  v_starts     date;
  v_next       date;
  v_has_first  boolean;
  v_first      integer;
begin
  -- Toute condition inconnue (clé absente → NULL) compte comme invalide : « is not false ».
  if (jsonb_typeof(q) <> 'object' or jsonb_typeof(t) <> 'object') is not false then return false; end if;

  v_plan      := t ->> 'planCode';
  v_billing   := t ->> 'billingOption';
  v_cycle     := t ->> 'cycle';
  v_recurring := (t ->> 'recurringPriceCents')::integer;
  v_opening   := (t ->> 'openingFeeCents')::integer;
  v_total     := (q #>> '{dueToday,totalCents}')::integer;
  v_starts    := (q ->> 'startsOn')::date;
  v_next      := (q #>> '{recurring,nextChargeOn}')::date;

  -- Champs présents et bien formés
  if (v_plan not in ('trajet', 'depart', 'elan', 'envol')
     or v_billing not in ('monthly', 'monthly_commitment', 'annual')
     or (t ->> 'gridVersion') !~ '^\d{4}-\d{2}$'
     or (t ->> 'includedFilingFrequency') not in ('monthly', 'quarterly', 'annual')
     or jsonb_typeof(t -> 'quickbooksIncluded') <> 'boolean'
     or (t ->> 'includedTransactions')::integer <= 0
     or (t ->> 'includedAccounts')::integer <= 0
     or (t ->> 'extraTransactionCents')::integer < 0
     or (t ->> 'extraAccountCents')::integer < 0
     or (t ->> 'extraFilingCents')::integer < 0
     or (t ->> 'openingDiscountCents')::integer < 0
     or v_recurring <= 0 or v_opening < 0 or v_total <= 0
     or extract(day from v_starts) <> 1 or extract(day from v_next) <> 1
 ) is not false then return false; end if;

  -- Facturation : Trajet au mois seulement, l'annuel facture à l'année
  if (v_plan = 'trajet' and v_billing <> 'monthly') is not false then return false; end if;
  if (v_cycle <> (case when v_billing = 'annual' then 'year' else 'month' end)) is not false then return false; end if;
  if ((q #>> '{recurring,cycle}') is distinct from v_cycle
     or (q #>> '{recurring,amountCents}')::integer is distinct from v_recurring) is not false then return false; end if;
  if ((t ->> 'stripeRecurringLookupKey') is distinct from
     (v_plan || '_' || (case when v_billing = 'annual' then 'annual' else 'monthly' end) || '_'
            || replace(t ->> 'gridVersion', '-', '_'))) is not false then return false; end if;

  -- Lignes du jour : l'ouverture, et le premier cycle seulement si le mois en cours est traité
  if (jsonb_typeof(q #> '{dueToday,lines}') <> 'array') is not false then return false; end if;
  select coalesce(sum((l ->> 'amountCents')::integer), 0),
         bool_or(l ->> 'kind' = 'first_period'),
         max(case when l ->> 'kind' = 'first_period' then (l ->> 'amountCents')::integer end)
    into v_sum, v_has_first, v_first
    from jsonb_array_elements(q #> '{dueToday,lines}') l;
  if (v_sum <> v_total) is not false then return false; end if;
  if ((select count(*) from jsonb_array_elements(q #> '{dueToday,lines}') l
       where l ->> 'kind' = 'opening_fee' and (l ->> 'amountCents')::integer = v_opening) <> 1) is not false then return false; end if;
  if ((select count(*) from jsonb_array_elements(q #> '{dueToday,lines}') l
       where l ->> 'kind' not in ('opening_fee', 'first_period')) > 0) is not false then return false; end if;

  if coalesce(v_has_first, false) then
    -- Mois en cours : le premier cycle est payé aujourd'hui, le prochain prélèvement suit d'un cycle
    if (v_first <> v_recurring) is not false then return false; end if;
    if (v_next <> (v_starts + (case when v_cycle = 'year' then interval '12 months' else interval '1 month' end))::date)
       is not false then return false; end if;
  else
    -- Mois suivant : seule l'ouverture aujourd'hui, le premier prélèvement le jour du début
    if (v_next <> v_starts) is not false then return false; end if;
  end if;

  return true;
exception when others then
  -- Champ absent, mauvais type ou valeur impossible : invalide, jamais « inconnu »
  return false;
end
$$;

create table public.checkout_attempts (
  id                       uuid primary key,
  created_at               timestamptz not null default now(),
  email                    text not null check (email = lower(email) and email like '_%@_%'),
  phone                    text not null check (length(trim(phone)) > 0),
  display_name             text not null check (length(trim(display_name)) > 0),
  books_up_to_date         boolean not null,
  uses_quickbooks          boolean not null,
  estimated_transactions   integer not null check (estimated_transactions >= 0),
  granted_quote            jsonb not null check (private.is_valid_checkout_quote(granted_quote)),
  stripe_session_id        text unique,
  stripe_customer_id       text,
  stripe_payment_intent_id text unique,
  stripe_payment_method_id text,
  paid_amount_cents        integer check (paid_amount_cents > 0),
  paid_at                  timestamptz,
  stripe_subscription_id   text unique,
  stripe_price_id          text,
  stripe_status            text,
  subscription_created_at  timestamptz,
  completed_at             timestamptz,
  rejected_at              timestamptz,
  rejection_reason         text,
  refund_id                text unique,
  refund_amount_cents      integer,
  refund_status            text check (refund_status in ('pending', 'succeeded', 'failed', 'canceled', 'requires_action')),
  abandoned_at             timestamptz,
  anonymized_at            timestamptz,
  lease_token              uuid,
  lease_expires_at         timestamptz,
  check (num_nonnulls(completed_at, rejected_at) <= 1),
  check (abandoned_at is null or completed_at is null),
  check (stripe_subscription_id is null or (stripe_price_id is not null and subscription_created_at is not null)),
  check ((paid_at is null) = (paid_amount_cents is null)),
  check (paid_at is null or stripe_payment_intent_id is not null),
  check (completed_at is null or stripe_subscription_id is not null),
  check (rejected_at is null or (refund_id is not null and refund_amount_cents = paid_amount_cents)),
  check ((lease_token is null) = (lease_expires_at is null))
);
-- Une seule tentative ouverte par courriel (inscriptions simultanées)
create unique index checkout_attempts_one_open_per_email on public.checkout_attempts (email)
  where completed_at is null and rejected_at is null and abandoned_at is null;
comment on table public.checkout_attempts is
  'Fiches temporaires d''inscription. granted_quote : récapitulatif de domain/pricing tel que vu par le client, jamais recalculé. Le dossier client garde les informations durables; ces fiches sont purgées (purge_checkout_attempts).';

alter table public.checkout_attempts enable row level security;
revoke all on public.checkout_attempts from public, anon, authenticated;
grant select on public.checkout_attempts to service_role;
-- Lecture par l'administratrice seulement (double authentification exigée par is_admin)
grant select on public.checkout_attempts to authenticated;
create policy "admin : lecture" on public.checkout_attempts
  for select to authenticated using ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- Création : refus avant tout paiement
--   P0004 : dossier ouvert ou client refusé définitivement
--   P0006 : ancien client → réouverture par l'application, pas par le site
--   P0005 : une autre tentative est ouverte pour ce courriel (DETAIL = son id)
--   22023 : récapitulatif incomplet ou incohérent
-- -----------------------------------------------------------------------------
create function public.checkout_attempt_create(
  p_id uuid, p_email text, p_phone text, p_display_name text,
  p_books_up_to_date boolean, p_uses_quickbooks boolean,
  p_estimated_transactions integer, p_quote jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
  v_open  uuid;
begin
  case public.check_signup_eligibility(v_email, p_phone)
    when 'active', 'refused' then
      raise exception 'Inscription refusée' using errcode = 'P0004';
    when 'returning' then
      raise exception 'Ancien client : réouverture par l''application' using errcode = 'P0006';
    else null;  -- 'new' ou 'review' (même téléphone : vérifié à l'appel de bienvenue)
  end case;
  if not private.is_valid_checkout_quote(p_quote) then
    raise exception 'Récapitulatif incomplet ou incohérent' using errcode = '22023';
  end if;

  -- Une session Stripe vit au plus 24 h : au-delà, une tentative non payée est abandonnée.
  update public.checkout_attempts set abandoned_at = now()
   where email = v_email and completed_at is null and rejected_at is null and abandoned_at is null
     and paid_at is null and created_at < now() - interval '24 hours';

  select id into v_open from public.checkout_attempts
   where email = v_email and completed_at is null and rejected_at is null and abandoned_at is null;
  if v_open is not null then
    raise exception 'Une inscription est déjà en cours pour ce courriel'
      using errcode = 'P0005', detail = v_open::text;
  end if;

  insert into public.checkout_attempts
    (id, email, phone, display_name, books_up_to_date, uses_quickbooks, estimated_transactions, granted_quote)
  values (p_id, v_email, trim(p_phone), trim(p_display_name), p_books_up_to_date,
          p_uses_quickbooks, p_estimated_transactions, p_quote);
end $$;

-- Tentative ouverte d'un courriel (pour reprendre ou remplacer sa session)
create function public.checkout_attempt_open_for(p_email text)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.checkout_attempts
   where email = lower(trim(p_email)) and completed_at is null and rejected_at is null and abandoned_at is null
$$;

-- Abandon d'une tentative jamais payée (sa session Stripe a été expirée)
create function public.checkout_attempt_abandon(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.checkout_attempts set abandoned_at = now()
   where id = p_id and paid_at is null and completed_at is null and rejected_at is null and abandoned_at is null
     and (lease_token is null or lease_expires_at < now());
  if not found then raise exception 'Tentative payée, en traitement ou déjà fermée' using errcode = 'P0001'; end if;
end $$;

create function public.checkout_attempt_save_session(p_id uuid, p_session_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.checkout_attempts set stripe_session_id = p_session_id
   where id = p_id and (stripe_session_id is null or stripe_session_id = p_session_id)
     and completed_at is null and rejected_at is null and abandoned_at is null;
  if not found then raise exception 'Session différente ou tentative fermée' using errcode = 'P0001'; end if;
end $$;

create function public.checkout_attempt_claim(p_id uuid, p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.checkout_attempts
     set lease_token = p_token, lease_expires_at = now() + interval '5 minutes'
   where id = p_id and (lease_token is null or lease_expires_at < now() or lease_token = p_token);
  return found;
end $$;

create function public.checkout_attempt_release(p_id uuid, p_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.checkout_attempts set lease_token = null, lease_expires_at = null
   where id = p_id and lease_token = p_token;
end $$;

-- Paiement constaté chez Stripe. Une tentative n'est abandonnée qu'après l'expiration de sa
-- session chez Stripe, donc ne devrait jamais être payée ensuite; si c'est le cas, le
-- paiement est quand même enregistré pour être remboursé (le service s'en charge).
create function public.checkout_attempt_paid(
  p_id uuid, p_token uuid, p_session_id text, p_customer_id text, p_intent_id text,
  p_method_id text, p_amount_cents integer
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.checkout_attempts set
    stripe_customer_id       = p_customer_id,
    stripe_payment_intent_id = p_intent_id,
    stripe_payment_method_id = p_method_id,
    paid_amount_cents        = p_amount_cents,
    paid_at                  = coalesce(paid_at, now())
  where id = p_id and lease_token = p_token and lease_expires_at > now()
    and stripe_session_id = p_session_id and rejected_at is null and completed_at is null
    and (stripe_customer_id is null or stripe_customer_id = p_customer_id)
    and (stripe_payment_intent_id is null or stripe_payment_intent_id = p_intent_id)
    and (stripe_payment_method_id is null or stripe_payment_method_id = p_method_id)
    and (paid_amount_cents is null or paid_amount_cents = p_amount_cents);
  if not found then raise exception 'Paiement incohérent ou verrou perdu' using errcode = 'P0001'; end if;
end $$;

create function public.checkout_attempt_subscription(
  p_id uuid, p_token uuid, p_subscription_id text, p_price_id text, p_status text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.checkout_attempts set
    stripe_subscription_id  = p_subscription_id,
    stripe_price_id         = p_price_id,
    stripe_status           = p_status,
    subscription_created_at = coalesce(subscription_created_at, now())
  where id = p_id and lease_token = p_token and lease_expires_at > now()
    and paid_at is not null and completed_at is null and rejected_at is null and abandoned_at is null
    and paid_amount_cents = (granted_quote #>> '{dueToday,totalCents}')::integer
    and (stripe_subscription_id is null or stripe_subscription_id = p_subscription_id)
    and (stripe_price_id is null or stripe_price_id = p_price_id);
  if not found then raise exception 'Abonnement incohérent ou verrou perdu' using errcode = 'P0001'; end if;
end $$;

-- Création du dossier. L'événement Stripe est marqué traité dans la même transaction
-- (handle_checkout_completed). Arguments nommés : un changement de signature échoue
-- clairement au lieu de décaler les valeurs. Jamais « terminée » sans dossier retrouvé.
create function public.checkout_attempt_finish(
  p_id uuid, p_token uuid, p_event_id text, p_invitation_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  a        public.checkout_attempts%rowtype;
  t        jsonb;
  v_client uuid;
begin
  select * into a from public.checkout_attempts where id = p_id for update;
  if not found or a.lease_token is distinct from p_token or a.lease_expires_at < now() then
    raise exception 'Verrou de tentative perdu' using errcode = 'P0001';
  end if;
  if a.completed_at is not null then
    select m.client_id into v_client
      from public.subscriptions s join public.mandates m on m.id = s.mandate_id
     where s.stripe_subscription_id = a.stripe_subscription_id;
    return v_client;
  end if;
  if a.rejected_at is not null or a.abandoned_at is not null or a.paid_at is null or a.stripe_subscription_id is null
     or a.paid_amount_cents <> (a.granted_quote #>> '{dueToday,totalCents}')::integer then
    raise exception 'Tentative non payée, incohérente ou refusée' using errcode = 'P0001';
  end if;

  t := a.granted_quote -> 'terms';
  v_client := public.handle_checkout_completed(
    p_event_id                  => p_event_id,
    p_email                     => a.email,
    p_display_name              => a.display_name,
    p_plan_code                 => t ->> 'planCode',
    p_billing_option            => (t ->> 'billingOption')::public.billing_option,
    p_starts_on                 => (a.granted_quote ->> 'startsOn')::date,
    p_stripe_customer_id        => a.stripe_customer_id,
    p_stripe_subscription_id    => a.stripe_subscription_id,
    p_stripe_status             => a.stripe_status,
    p_books_up_to_date          => a.books_up_to_date,
    p_uses_quickbooks           => a.uses_quickbooks,
    p_estimated_transactions    => a.estimated_transactions,
    p_invitation_expires_at     => p_invitation_expires_at,
    p_recurring_price_cents     => (t ->> 'recurringPriceCents')::integer,
    p_included_transactions     => (t ->> 'includedTransactions')::integer,
    p_extra_transaction_cents   => (t ->> 'extraTransactionCents')::integer,
    p_opening_fee_cents         => (t ->> 'openingFeeCents')::integer,
    p_stripe_price_id           => a.stripe_price_id,
    p_opening_discount_cents    => (t ->> 'openingDiscountCents')::integer,
    p_grid_version              => t ->> 'gridVersion',
    p_included_accounts         => (t ->> 'includedAccounts')::integer,
    p_included_filing_frequency => (t ->> 'includedFilingFrequency')::public.filing_frequency,
    p_quickbooks_included       => (t ->> 'quickbooksIncluded')::boolean,
    p_extra_account_cents       => (t ->> 'extraAccountCents')::integer,
    p_extra_filing_cents        => (t ->> 'extraFilingCents')::integer,
    p_phone                     => a.phone
  );
  if v_client is null then
    -- Événement déjà traité : le dossier doit exister pour cet abonnement.
    select m.client_id into v_client
      from public.subscriptions s join public.mandates m on m.id = s.mandate_id
     where s.stripe_subscription_id = a.stripe_subscription_id;
  end if;
  if v_client is null then
    raise exception 'Paiement sans dossier retrouvé pour l''abonnement %', a.stripe_subscription_id
      using errcode = 'P0001';
  end if;
  update public.checkout_attempts set completed_at = now() where id = p_id;
  return v_client;
end $$;

-- Refus : seulement avec un remboursement du montant payé, réussi ou en cours.
-- Un remboursement en échec reste « à traiter » (refund_status, vue d'administration).
create function public.checkout_attempt_reject(
  p_id uuid, p_token uuid, p_refund_id text, p_refund_amount_cents integer, p_refund_status text, p_reason text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_refund_status not in ('pending', 'succeeded') then
    raise exception 'Remboursement non accepté par Stripe (%)', p_refund_status using errcode = 'P0001';
  end if;
  update public.checkout_attempts set
    refund_id = p_refund_id, refund_amount_cents = p_refund_amount_cents, refund_status = p_refund_status,
    rejection_reason = p_reason, rejected_at = coalesce(rejected_at, now())
  where id = p_id and lease_token = p_token and lease_expires_at > now()
    and paid_at is not null and completed_at is null
    and p_refund_amount_cents = paid_amount_cents
    and (refund_id is null or refund_id = p_refund_id);
  if not found then raise exception 'Remboursement incomplet, incohérent ou verrou perdu' using errcode = 'P0001'; end if;
end $$;

-- Suivi d'un remboursement (événements refund.updated / refund.failed)
create function public.checkout_attempt_refund_status(p_refund_id text, p_status text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.checkout_attempts set refund_status = p_status
   where refund_id = p_refund_id
     and not (refund_status = 'succeeded' and p_status = 'pending');  -- jamais revenir en arrière
  return found;
end $$;

-- -----------------------------------------------------------------------------
-- État de l'abonnement, relu chez Stripe à chaque événement
--
-- L'événement ne sert que de signal : le service relit l'abonnement chez Stripe
-- et transmet son état actuel avec l'heure de cette lecture. L'ordre d'arrivée
-- des événements ne compte donc plus; seule une lecture plus ancienne que la
-- dernière appliquée est ignorée (deux traitements en parallèle).
-- -----------------------------------------------------------------------------
alter table public.subscriptions add column stripe_state_read_at timestamptz;

create function public.apply_stripe_subscription_state(
  p_event_id text, p_type text, p_subscription_id text, p_status text, p_read_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  s public.subscriptions%rowtype;
begin
  if p_status is null or p_read_at is null then
    raise exception 'État Stripe incomplet' using errcode = '22023';
  end if;
  if not public.record_stripe_event(p_event_id, p_type) then return false; end if;

  select * into s from public.subscriptions where stripe_subscription_id = p_subscription_id for update;
  if not found then
    -- Événement arrivé avant la création du dossier : erreur pour que Stripe le renvoie.
    -- Toute la transaction est annulée : l'événement n'est pas marqué reçu.
    raise exception 'Abonnement Stripe pas encore associé : %', p_subscription_id using errcode = 'P0001';
  end if;

  if s.stripe_state_read_at is null or p_read_at > s.stripe_state_read_at then
    update public.subscriptions set
      stripe_status        = p_status,
      stripe_state_read_at = p_read_at,
      -- En retard ou impayé : début du délai de grâce (une seule fois). Sinon : terminé.
      payment_failed_at    = case when p_status in ('past_due', 'unpaid', 'incomplete')
                                  then coalesce(payment_failed_at, p_read_at) end,
      read_only_since      = case when p_status in ('past_due', 'unpaid', 'incomplete')
                                  then read_only_since end
    where id = s.id;
  end if;

  update public.stripe_events set processed_at = now() where id = p_event_id;
  return true;
end $$;

-- -----------------------------------------------------------------------------
-- Vue d'administration : les inscriptions, classées
-- -----------------------------------------------------------------------------
create view public.admin_checkout_attempts with (security_invoker = true) as
select
  a.id,
  a.created_at,
  a.display_name,
  a.email,
  a.phone,
  a.granted_quote #>> '{terms,planCode}'                 as plan_code,
  a.granted_quote #>> '{terms,billingOption}'            as billing_option,
  (a.granted_quote #>> '{dueToday,totalCents}')::integer as due_today_cents,
  a.paid_amount_cents,
  a.paid_at,
  a.completed_at,
  a.rejected_at,
  a.rejection_reason,
  a.refund_amount_cents,
  a.refund_status,
  a.abandoned_at,
  case
    when a.refund_status = 'failed'
      or (a.paid_at is not null and a.completed_at is null and a.rejected_at is null
          and a.paid_at < now() - interval '15 minutes')        then 'to_handle'
    when a.rejected_at is not null                             then 'refused'
    when a.completed_at is not null                            then 'completed'
    when a.abandoned_at is not null
      or (a.paid_at is null and a.created_at < now() - interval '24 hours') then 'abandoned'
    else 'in_progress'
  end as category
from public.checkout_attempts a
where a.anonymized_at is null or a.refund_status = 'failed';
comment on view public.admin_checkout_attempts is
  'Inscriptions pour l''administration. to_handle : payé sans dossier depuis 15 min, ou remboursement en échec (urgent : le client a payé).';
revoke all on public.admin_checkout_attempts from public, anon;
grant select on public.admin_checkout_attempts to authenticated;

-- -----------------------------------------------------------------------------
-- Purge (Loi 25), appelée chaque jour par scheduled-jobs
--   jamais payées : supprimées après p_unpaid_days;
--   terminées : supprimées après p_done_days (le dossier client garde l'essentiel);
--   refusées : coordonnées effacées après p_done_days, montants et remboursement gardés.
-- Rien n'est purgé tant que le paiement attend un dossier ou qu'un remboursement a échoué.
-- -----------------------------------------------------------------------------
create function public.purge_checkout_attempts(p_unpaid_days integer default 30, p_done_days integer default 90)
returns table (deleted_unpaid integer, deleted_completed integer, anonymized_refused integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_unpaid integer; v_done integer; v_refused integer;
begin
  if p_unpaid_days < 1 or p_done_days < 1 then
    raise exception 'Durées de conservation invalides' using errcode = '22023';
  end if;

  delete from public.checkout_attempts
   where paid_at is null and created_at < now() - make_interval(days => p_unpaid_days);
  get diagnostics v_unpaid = row_count;

  delete from public.checkout_attempts
   where completed_at is not null and completed_at < now() - make_interval(days => p_done_days);
  get diagnostics v_done = row_count;

  update public.checkout_attempts set
    email = 'efface+' || id::text || '@invalid',
    phone = '-',
    display_name = 'Effacé',
    anonymized_at = now()
  where rejected_at is not null and anonymized_at is null
    and refund_status = 'succeeded'
    and rejected_at < now() - make_interval(days => p_done_days);
  get diagnostics v_refused = row_count;

  return query select v_unpaid, v_done, v_refused;
end $$;

-- -----------------------------------------------------------------------------
-- Privilèges : rôle service seulement
-- -----------------------------------------------------------------------------
revoke execute on function
  private.is_valid_checkout_quote(jsonb),
  public.checkout_attempt_create(uuid, text, text, text, boolean, boolean, integer, jsonb),
  public.checkout_attempt_open_for(text),
  public.checkout_attempt_abandon(uuid),
  public.checkout_attempt_save_session(uuid, text),
  public.checkout_attempt_claim(uuid, uuid),
  public.checkout_attempt_release(uuid, uuid),
  public.checkout_attempt_paid(uuid, uuid, text, text, text, text, integer),
  public.checkout_attempt_subscription(uuid, uuid, text, text, text),
  public.checkout_attempt_finish(uuid, uuid, text, timestamptz),
  public.checkout_attempt_reject(uuid, uuid, text, integer, text, text),
  public.checkout_attempt_refund_status(text, text),
  public.apply_stripe_subscription_state(text, text, text, text, timestamptz),
  public.purge_checkout_attempts(integer, integer)
from public, anon, authenticated;

grant execute on function
  public.checkout_attempt_create(uuid, text, text, text, boolean, boolean, integer, jsonb),
  public.checkout_attempt_open_for(text),
  public.checkout_attempt_abandon(uuid),
  public.checkout_attempt_save_session(uuid, text),
  public.checkout_attempt_claim(uuid, uuid),
  public.checkout_attempt_release(uuid, uuid),
  public.checkout_attempt_paid(uuid, uuid, text, text, text, text, integer),
  public.checkout_attempt_subscription(uuid, uuid, text, text, text),
  public.checkout_attempt_finish(uuid, uuid, text, timestamptz),
  public.checkout_attempt_reject(uuid, uuid, text, integer, text, text),
  public.checkout_attempt_refund_status(text, text),
  public.apply_stripe_subscription_state(text, text, text, text, timestamptz),
  public.purge_checkout_attempts(integer, integer)
to service_role;
