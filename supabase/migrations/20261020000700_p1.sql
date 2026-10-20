-- =============================================================================
-- P1 — premiers mois après le lancement
-- Compteur de transactions (manuel), état détaillé du dossier, déclarations de
-- TPS/TVQ, demandes récurrentes. Mêmes règles que le P0.
-- =============================================================================

-- Mois : toujours le 1er du mois
create domain public.month_start as date check (extract(day from value) = 1);

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table public.monthly_transaction_counts (
  client_id         uuid not null references public.clients (id) on delete cascade,
  month             public.month_start not null,
  transaction_count integer not null check (transaction_count >= 0),
  entered_by        uuid references auth.users (id) on delete set null,
  entered_at        timestamptz not null default now(),
  primary key (client_id, month)
);
comment on table public.monthly_transaction_counts is
  'Nombre saisi par la teneuse de livres (par admin-api). Remplacé par QuickBooks en P2. Le coût des transactions supplémentaires n''est pas stocké : domain/pricing le calcule.';

create table public.overage_charges (
  client_id              uuid not null references public.clients (id) on delete cascade,
  month                  public.month_start not null,
  billed_count           integer not null check (billed_count > 0),
  amount_cents           integer not null check (amount_cents > 0),
  stripe_invoice_item_id text not null unique,
  billed_at              timestamptz not null default now(),
  primary key (client_id, month)
);
comment on table public.overage_charges is
  'Ce qui a été facturé, tel quel (fait historique). Un mois n''est facturé qu''une fois.';

create table public.bookkeeping_months (
  client_id             uuid not null references public.clients (id) on delete cascade,
  month                 public.month_start not null,
  processing_started_at timestamptz,
  completed_at          timestamptz,
  primary key (client_id, month),
  check (completed_at is null or processing_started_at is not null)
);
comment on table public.bookkeeping_months is
  'Statut par mois. « En attente du client » se dérive des éléments en attente; « en traitement » et « terminé » sont des faits saisis.';

create type public.tax_balance_kind as enum ('payable', 'refund', 'nil');

create table public.tax_filings (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  due_on       date not null,
  balance_kind public.tax_balance_kind,   -- à payer, à recevoir (remboursement) ou nul
  amount_cents integer check (amount_cents >= 0),
  filed_at     timestamptz,
  unique (client_id, period_start, period_end),
  check (period_end > period_start),
  check ((balance_kind is null) = (amount_cents is null)),
  check (balance_kind is distinct from 'nil' or amount_cents = 0),
  check (balance_kind is distinct from 'refund' and balance_kind is distinct from 'payable' or amount_cents > 0)
);
comment on column public.tax_filings.amount_cents is 'Toujours positif; le sens est donné par balance_kind. Vide tant que la déclaration n''est pas calculée.';
create index tax_filings_client_idx on public.tax_filings (client_id, due_on);

create table public.recurring_request_rules (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients (id) on delete cascade,
  document_type_code text not null references public.document_types (code),
  title              text not null,
  day_of_month       smallint not null check (day_of_month between 1 and 28),
  active_from        public.month_start not null,
  active_to          public.month_start,
  created_by         uuid references auth.users (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  check (active_to is null or active_to > active_from)
);
create index recurring_request_rules_client_idx on public.recurring_request_rules (client_id);

create table public.recurring_request_runs (
  rule_id    uuid not null references public.recurring_request_rules (id) on delete cascade,
  month      public.month_start not null,
  request_id uuid not null unique references public.document_requests (id) on delete cascade,
  primary key (rule_id, month)
);
comment on table public.recurring_request_runs is 'Empêche de créer deux fois la demande d''un même mois.';

-- -----------------------------------------------------------------------------
-- Intégrité : la demande créée appartient au client de la règle
-- -----------------------------------------------------------------------------
create or replace function private.client_of(p_table text, p_id uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_client uuid;
begin
  case p_table
    when 'documents'               then select client_id into v_client from public.documents               where id = p_id;
    when 'document_requests'       then select client_id into v_client from public.document_requests       where id = p_id;
    when 'questions'               then select client_id into v_client from public.questions               where id = p_id;
    when 'messages'                then select client_id into v_client from public.messages                where id = p_id;
    when 'reminders'               then select client_id into v_client from public.reminders               where id = p_id;
    when 'recurring_request_rules' then select client_id into v_client from public.recurring_request_rules where id = p_id;
    else raise exception 'client_of : table inconnue %', p_table;
  end case;
  return v_client;
end
$$;

create function private.check_recurring_run()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  perform private.assert_same_client('recurring_request_rules', new.rule_id, 'document_requests', new.request_id);
  return new;
end
$$;
create trigger recurring_request_runs_same_client
  before insert or update on public.recurring_request_runs
  for each row execute function private.check_recurring_run();

do $$
declare t text;
begin
  foreach t in array array['monthly_transaction_counts', 'overage_charges', 'bookkeeping_months',
                           'tax_filings', 'recurring_request_rules'] loop
    execute format(
      'create trigger %I before update of client_id on public.%I
         for each row when (old.client_id is distinct from new.client_id)
         execute function private.forbid_client_change()',
      t || '_client_immutable', t);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.monthly_transaction_counts enable row level security;
alter table public.overage_charges            enable row level security;
alter table public.bookkeeping_months         enable row level security;
alter table public.tax_filings                enable row level security;
alter table public.recurring_request_rules    enable row level security;
alter table public.recurring_request_runs     enable row level security;

-- Compteur et facturation : lecture seulement (écriture par admin-api et scheduled-jobs)
grant select on public.monthly_transaction_counts, public.overage_charges to authenticated;
create policy "client : lecture" on public.monthly_transaction_counts
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : lecture" on public.monthly_transaction_counts
  for select to authenticated using ((select private.is_admin()));
create policy "client : lecture" on public.overage_charges
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : lecture" on public.overage_charges
  for select to authenticated using ((select private.is_admin()));

-- État du dossier et déclarations : mis à jour directement par l'administratrice
grant select, delete on public.bookkeeping_months, public.tax_filings to authenticated;
grant insert (client_id, month, processing_started_at, completed_at) on public.bookkeeping_months to authenticated;
grant update (processing_started_at, completed_at) on public.bookkeeping_months to authenticated;
grant insert (client_id, period_start, period_end, due_on, balance_kind, amount_cents, filed_at) on public.tax_filings to authenticated;
grant update (period_start, period_end, due_on, balance_kind, amount_cents, filed_at) on public.tax_filings to authenticated;
create policy "client : lecture" on public.bookkeeping_months
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : tout" on public.bookkeeping_months
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "client : lecture" on public.tax_filings
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : tout" on public.tax_filings
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

grant select, delete on public.recurring_request_rules to authenticated;
grant insert (client_id, document_type_code, title, day_of_month, active_from, active_to) on public.recurring_request_rules to authenticated;
grant update (document_type_code, title, day_of_month, active_to) on public.recurring_request_rules to authenticated;
grant select on public.recurring_request_runs to authenticated;
create policy "client : lecture" on public.recurring_request_rules
  for select to authenticated using (client_id in (select private.my_client_ids()));
create policy "admin : tout" on public.recurring_request_rules
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "admin : lecture" on public.recurring_request_runs
  for select to authenticated using ((select private.is_admin()));

-- -----------------------------------------------------------------------------
-- Vue du compteur : « 23 / 20 — 3 transactions supplémentaires (13,50 $) »
-- Quota et prix unitaire viennent des conditions accordées au client (photographie);
-- la facture elle-même reste calculée par domain/pricing (overage_charges).
-- -----------------------------------------------------------------------------
create view public.transaction_counter with (security_invoker = true) as
select
  t.client_id,
  t.month,
  t.transaction_count,
  cur.included_transactions,
  greatest(t.transaction_count - coalesce(cur.included_transactions, t.transaction_count), 0) as extra_transactions,
  cur.extra_transaction_cents,
  greatest(t.transaction_count - coalesce(cur.included_transactions, t.transaction_count), 0)
    * cur.extra_transaction_cents as extra_amount_cents  -- estimation affichée, avant taxes
from public.monthly_transaction_counts t
left join lateral (
  select pp.included_transactions, pp.extra_transaction_cents
  from public.mandates m
  join public.subscriptions s on s.mandate_id = m.id
  join public.subscription_plan_periods pp on pp.subscription_id = s.id
  where m.client_id = t.client_id
    and daterange(pp.effective_from, pp.effective_to, '[)')
        @> least((t.month + interval '1 month - 1 day')::date, private.today())
  order by pp.effective_from desc
  limit 1
) cur on true;

grant select on public.transaction_counter to authenticated;

alter publication supabase_realtime add table
  public.monthly_transaction_counts,
  public.bookkeeping_months,
  public.tax_filings;
