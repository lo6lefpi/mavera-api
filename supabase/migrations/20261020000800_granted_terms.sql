-- =============================================================================
-- Conditions accordées complètes (revue de domain/pricing, 20 octobre 2026)
--
-- La photographie contractuelle de chaque période de forfait garde maintenant
-- tout ce qui change ce qu'un client paie ou ce à quoi il a droit : comptes
-- inclus, fréquence de TPS/TVQ incluse, QuickBooks Ledger fourni, prix d'un
-- compte et d'une déclaration en plus, et la version de la grille (qui renvoie
-- à la version du contrat de services). Les suppléments se calculent à partir
-- de ces valeurs, jamais de la grille du jour.
--
-- L'abonnement garde aussi le rabais obtenu sur l'ouverture grâce à
-- l'engagement : c'est ce qui est facturé si le client annule avant la fin.
--
-- Aucune donnée en production : colonnes obligatoires sans valeur par défaut.
-- =============================================================================

alter table public.subscriptions
  add column opening_discount_cents integer not null check (opening_discount_cents >= 0);
comment on column public.subscriptions.opening_discount_cents is
  'Rabais obtenu sur l''ouverture grâce à l''engagement (0 sans engagement). Facturé si le client annule avant la fin de l''engagement (domain/pricing, earlyTerminationFee).';

alter table public.subscription_plan_periods
  add column grid_version              text not null check (grid_version ~ '^\d{4}-\d{2}$'),
  add column included_accounts         smallint check (included_accounts > 0),  -- null : selon la soumission (sur mesure)
  add column included_filing_frequency public.filing_frequency,                -- null : selon la soumission (sur mesure)
  add column quickbooks_included       boolean not null,
  add column extra_account_cents       integer not null check (extra_account_cents >= 0),
  add column extra_filing_cents        integer not null check (extra_filing_cents >= 0),
  add constraint periods_custom_terms_together
    check ((included_accounts is null) = (included_filing_frequency is null));

comment on column public.subscription_plan_periods.grid_version is
  'Version de la grille de domain/pricing au moment de l''acceptation; renvoie à la version du contrat de services.';

-- Les deux fonctions qui écrivent ces tables reçoivent les nouvelles conditions.
drop function public.handle_checkout_completed(text, text, text, text, public.billing_option, date, text, text, text, boolean, boolean, integer, timestamptz, integer, integer, integer, integer, text, text);
drop function public.change_plan(uuid, text, date, integer, integer, integer, text);

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
  p_opening_discount_cents  integer,
  p_grid_version            text,
  p_included_accounts       integer,
  p_included_filing_frequency public.filing_frequency,
  p_quickbooks_included     boolean,
  p_extra_account_cents     integer,
  p_extra_filing_cents      integer,
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
                                    opening_fee_cents, opening_discount_cents, stripe_status)
  values (v_mandate, p_stripe_subscription_id, p_billing_option, p_starts_on,
          p_opening_fee_cents, p_opening_discount_cents, p_stripe_status)
  returning id into v_sub;

  -- Téléphone d'un client fermé définitivement : inscription acceptée, à vérifier
  insert into public.signup_flags (mandate_id, matched_client_id)
  select v_mandate, r from private.refused_clients_for_phone(p_phone) r
  where r <> v_client;

  insert into public.subscription_plan_periods (subscription_id, plan_code, effective_from,
    recurring_price_cents, included_transactions, extra_transaction_cents, stripe_price_id,
    grid_version, included_accounts, included_filing_frequency, quickbooks_included,
    extra_account_cents, extra_filing_cents)
  values (v_sub, p_plan_code, p_starts_on,
    p_recurring_price_cents, p_included_transactions, p_extra_transaction_cents, p_stripe_price_id,
    p_grid_version, p_included_accounts, p_included_filing_frequency, p_quickbooks_included,
    p_extra_account_cents, p_extra_filing_cents);

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

create function public.change_plan(
  p_subscription            uuid,
  p_plan_code               text,
  p_effective_from          date,
  p_recurring_price_cents   integer,
  p_included_transactions   integer,
  p_extra_transaction_cents integer,
  p_stripe_price_id         text,
  p_grid_version            text,
  p_included_accounts       integer,
  p_included_filing_frequency public.filing_frequency,
  p_quickbooks_included     boolean,
  p_extra_account_cents     integer,
  p_extra_filing_cents      integer,
  -- Totaux d'ouverture après le changement (hausse : différence encaissée).
  -- null : inchangés (baisse).
  p_opening_fee_cents       integer default null,
  p_opening_discount_cents  integer default null)
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
    recurring_price_cents, included_transactions, extra_transaction_cents, stripe_price_id,
    grid_version, included_accounts, included_filing_frequency, quickbooks_included,
    extra_account_cents, extra_filing_cents)
  values (p_subscription, p_plan_code, p_effective_from,
    p_recurring_price_cents, p_included_transactions, p_extra_transaction_cents, p_stripe_price_id,
    p_grid_version, p_included_accounts, p_included_filing_frequency, p_quickbooks_included,
    p_extra_account_cents, p_extra_filing_cents);

  if (p_opening_fee_cents is null) <> (p_opening_discount_cents is null) then
    raise exception 'Frais d''ouverture : total et rabais vont ensemble' using errcode = '22023';
  end if;
  if p_opening_fee_cents is not null then
    update public.subscriptions
       set opening_fee_cents = p_opening_fee_cents,
           opening_discount_cents = p_opening_discount_cents
     where id = p_subscription;
  end if;
end
$$;

revoke execute on function
  public.handle_checkout_completed(text, text, text, text, public.billing_option, date, text, text, text, boolean, boolean, integer, timestamptz, integer, integer, integer, integer, text, integer, text, integer, public.filing_frequency, boolean, integer, integer, text),
  public.change_plan(uuid, text, date, integer, integer, integer, text, text, integer, public.filing_frequency, boolean, integer, integer, integer, integer)
from public, anon, authenticated;

grant execute on function
  public.handle_checkout_completed(text, text, text, text, public.billing_option, date, text, text, text, boolean, boolean, integer, timestamptz, integer, integer, integer, integer, text, integer, text, integer, public.filing_frequency, boolean, integer, integer, text),
  public.change_plan(uuid, text, date, integer, integer, integer, text, text, integer, public.filing_frequency, boolean, integer, integer, integer, integer)
to service_role;
