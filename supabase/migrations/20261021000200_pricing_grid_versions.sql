-- Plusieurs grilles peuvent entrer en vigueur le même mois.
-- Accepter AAAA-MM et AAAA-MM-JJ, sans réécrire les conditions déjà accordées.
-- Aucun prix n'est défini en SQL : domain/pricing reste la source de la grille.

alter table public.subscription_plan_periods
  drop constraint subscription_plan_periods_grid_version_check,
  add constraint subscription_plan_periods_grid_version_check
    check (grid_version ~ '^\d{4}-\d{2}(-\d{2})?$');

create or replace function private.is_valid_checkout_quote(q jsonb)
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
  v_sub        integer;
  v_gst        integer;
  v_qst        integer;
  v_rec_gst    integer;
  v_rec_qst    integer;
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
     or (t ->> 'gridVersion') !~ '^\d{4}-\d{2}(-\d{2})?$'
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

  -- Taxes du Québec : TPS 5 % et TVQ 9,975 %, par ligne, arrondies au cent (moitié vers le haut).
  -- Mêmes calculs que domain/pricing/taxes.ts; le total du jour est taxes comprises.
  if ((q ->> 'taxRegion') is distinct from 'QC') is not false then return false; end if;
  if (jsonb_typeof(q #> '{dueToday,lines}') <> 'array') is not false then return false; end if;
  if ((select count(*) from jsonb_array_elements(q #> '{dueToday,lines}') l
       where (l ->> 'gstCents')::integer is distinct from round((l ->> 'amountCents')::integer * 0.05)::integer
          or (l ->> 'qstCents')::integer is distinct from round((l ->> 'amountCents')::integer * 0.09975)::integer) > 0)
     is not false then return false; end if;
  select sum((l ->> 'amountCents')::integer), sum((l ->> 'gstCents')::integer), sum((l ->> 'qstCents')::integer)
    into v_sub, v_gst, v_qst
    from jsonb_array_elements(q #> '{dueToday,lines}') l;
  if ((q #>> '{dueToday,subtotalCents}')::integer is distinct from v_sub
     or (q #>> '{dueToday,gstCents}')::integer is distinct from v_gst
     or (q #>> '{dueToday,qstCents}')::integer is distinct from v_qst
     or v_total is distinct from v_sub + v_gst + v_qst) is not false then return false; end if;
  v_rec_gst := round(v_recurring * 0.05)::integer;
  v_rec_qst := round(v_recurring * 0.09975)::integer;
  if ((q #>> '{recurring,gstCents}')::integer is distinct from v_rec_gst
     or (q #>> '{recurring,qstCents}')::integer is distinct from v_rec_qst
     or (q #>> '{recurring,totalCents}')::integer is distinct from v_recurring + v_rec_gst + v_rec_qst)
     is not false then return false; end if;

  -- Lignes du jour : l'ouverture, et le premier cycle seulement si le mois en cours est traité
  if (jsonb_typeof(q #> '{dueToday,lines}') <> 'array') is not false then return false; end if;
  select coalesce(sum((l ->> 'amountCents')::integer), 0),
         bool_or(l ->> 'kind' = 'first_period'),
         max(case when l ->> 'kind' = 'first_period' then (l ->> 'amountCents')::integer end)
    into v_sum, v_has_first, v_first
    from jsonb_array_elements(q #> '{dueToday,lines}') l;
  if (v_sum <> v_sub) is not false then return false; end if;
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
