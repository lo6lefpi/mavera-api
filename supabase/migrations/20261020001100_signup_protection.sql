-- Protection de l'inscription publique (revue du point 2)
--   1. Empreinte des choix : une tentative ne peut pas être reprise avec d'autres choix.
--   2. La base n'abandonne plus seule une tentative : seul Stripe sait si une session
--      a été payée (paiement en traitement, webhook en retard). Le service expire la
--      session chez Stripe avant d'abandonner, et le webhook checkout.session.expired
--      abandonne les sessions expirées.
--   3. Suivi des remboursements : un remboursement de l'application pas encore
--      enregistré n'est plus ignoré (Stripe renvoie l'événement).
--   4. Limite d'appels de l'API publique, sans conserver de courriel ni d'adresse IP.

-- -----------------------------------------------------------------------------
-- 1 et 2. Création d'une tentative
-- -----------------------------------------------------------------------------
alter table public.checkout_attempts
  add column request_fingerprint text check (request_fingerprint ~ '^[0-9a-f]{64}$');
comment on column public.checkout_attempts.request_fingerprint is
  'SHA-256 des choix de la demande (forfait, facturation, mois, volume, réponses Trajet, coordonnées). Une reprise avec d''autres choix est refusée.';

drop function public.checkout_attempt_create(uuid, text, text, text, boolean, boolean, integer, jsonb);

create function public.checkout_attempt_create(
  p_id uuid, p_email text, p_phone text, p_display_name text,
  p_books_up_to_date boolean, p_uses_quickbooks boolean,
  p_estimated_transactions integer, p_quote jsonb, p_request_fingerprint text default null
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

  -- Jamais d'abandon automatique ici : le service vérifie d'abord la session chez Stripe.
  select id into v_open from public.checkout_attempts
   where email = v_email and completed_at is null and rejected_at is null and abandoned_at is null;
  if v_open is not null then
    raise exception 'Une inscription est déjà en cours pour ce courriel'
      using errcode = 'P0005', detail = v_open::text;
  end if;

  insert into public.checkout_attempts
    (id, email, phone, display_name, books_up_to_date, uses_quickbooks, estimated_transactions,
     granted_quote, request_fingerprint)
  values (p_id, v_email, trim(p_phone), trim(p_display_name), p_books_up_to_date,
          p_uses_quickbooks, p_estimated_transactions, p_quote, p_request_fingerprint);
end $$;

-- -----------------------------------------------------------------------------
-- 3. Suivi d'un remboursement : statut relu chez Stripe par le service
--   updated         : statut enregistré
--   not_recorded    : remboursement accepté de cette tentative, refus pas encore
--                     enregistré → le webhook répond en erreur, Stripe renverra
--   ignored         : ancien remboursement échoué ou remplacé, jamais enregistré
--   unknown_attempt : tentative inconnue (purgée, autre environnement) → ignoré
-- -----------------------------------------------------------------------------
drop function public.checkout_attempt_refund_status(text, text);

create function public.checkout_attempt_refund_status(p_attempt_id uuid, p_refund_id text, p_status text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  a public.checkout_attempts%rowtype;
begin
  if p_status is null or p_status not in ('pending', 'succeeded', 'failed', 'canceled', 'requires_action') then
    raise exception 'Statut de remboursement inconnu : %', p_status using errcode = '22023';
  end if;
  select * into a from public.checkout_attempts where id = p_attempt_id for update;
  if not found then return 'unknown_attempt'; end if;
  if a.refund_id = p_refund_id then
    update public.checkout_attempts set refund_status = p_status
     where id = p_attempt_id
       and not (refund_status = 'succeeded' and p_status = 'pending');  -- jamais revenir en arrière
    return 'updated';
  end if;
  -- Un refus est enregistré seulement avec un remboursement en cours ou réussi.
  if a.rejected_at is null and p_status in ('pending', 'succeeded', 'requires_action') then
    return 'not_recorded';
  end if;
  return 'ignored';
end $$;

-- -----------------------------------------------------------------------------
-- 4. Limite d'appels : fenêtre fixe; la clé est hachée (aucun courriel ni IP gardé)
-- -----------------------------------------------------------------------------
create table private.rate_limit_hits (
  key_hash     text        not null,
  window_start timestamptz not null,
  hits         integer     not null,
  primary key (key_hash, window_start)
);
create index rate_limit_hits_window on private.rate_limit_hits (window_start);
alter table private.rate_limit_hits enable row level security;

create function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_hits  integer;
begin
  if p_key is null or p_limit is null or p_limit < 1 or p_window_seconds is null
     or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'Limite d''appels invalide' using errcode = '22023';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into private.rate_limit_hits as r (key_hash, window_start, hits)
  values (encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), v_start, 1)
  on conflict (key_hash, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  delete from private.rate_limit_hits where window_start < now() - interval '2 days';
  return v_hits <= p_limit;
end $$;

-- -----------------------------------------------------------------------------
-- Privilèges : rôle service seulement
-- -----------------------------------------------------------------------------
revoke all on private.rate_limit_hits from public, anon, authenticated;
revoke execute on function
  public.checkout_attempt_create(uuid, text, text, text, boolean, boolean, integer, jsonb, text),
  public.checkout_attempt_refund_status(uuid, text, text),
  public.rate_limit_hit(text, integer, integer)
from public, anon, authenticated;
grant execute on function
  public.checkout_attempt_create(uuid, text, text, text, boolean, boolean, integer, jsonb, text),
  public.checkout_attempt_refund_status(uuid, text, text),
  public.rate_limit_hit(text, integer, integer)
to service_role;
