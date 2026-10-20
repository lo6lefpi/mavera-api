-- =============================================================================
-- Vues : tout ce qui se calcule au lieu de se stocker
--
-- security_invoker = true : la vue s'exécute avec les droits de la personne
-- qui la lit, donc la RLS des tables s'applique. Un client ne voit que ses
-- lignes; les colonnes tirées de tables réservées à l'administration (relances)
-- valent 0 pour lui.
--
-- Temps réel : Supabase Realtime ne diffuse pas les vues. L'application
-- s'abonne aux tables (messages, questions…) et relit la vue au changement.
-- =============================================================================

-- Date du jour à Montréal (la base est en UTC)
create function private.today()
returns date language sql stable set search_path = ''
as $$ select (pg_catalog.timezone('America/Toronto', pg_catalog.now()))::date $$;
grant execute on function private.today() to authenticated;

-- Dernier message du client au sujet d'un élément : les relances sont
-- reportées s'il a écrit depuis la dernière relance.
create view public.question_status with (security_invoker = true) as
select
  q.id as question_id,
  q.client_id,
  case
    when q.resolved_at is not null then 'resolved'
    when a.question_id is not null then 'answered'
    else 'pending'
  end as status,
  r.reminder_count,
  r.last_reminder_at,
  cm.last_client_message_at,
  (q.resolved_at is null and a.question_id is null and r.reminder_count >= 3) as needs_call
from public.questions q
left join public.question_answers a on a.question_id = q.id
cross join lateral (
  select count(*)::int as reminder_count, max(rm.sent_at) as last_reminder_at
  from public.reminder_questions rq join public.reminders rm on rm.id = rq.reminder_id
  where rq.question_id = q.id
) r
cross join lateral (
  select max(m.sent_at) as last_client_message_at
  from public.question_messages qm
  join public.messages m on m.id = qm.message_id
  join public.client_members mem on mem.client_id = m.client_id and mem.user_id = m.author_id
  where qm.question_id = q.id
) cm;

create view public.document_request_status with (security_invoker = true) as
select
  dr.id as request_id,
  dr.client_id,
  case
    when dr.canceled_at is not null then 'canceled'
    when dr.processed_at is not null then 'processed'
    when d.received_count > 0 then 'received'
    when dr.due_on < private.today() then 'overdue'
    else 'pending'
  end as status,
  d.received_count,
  r.reminder_count,
  r.last_reminder_at,
  cm.last_client_message_at,
  (dr.canceled_at is null and dr.processed_at is null and d.received_count = 0
   and r.reminder_count >= 3) as needs_call
from public.document_requests dr
cross join lateral (
  select count(*)::int as received_count
  from public.request_documents rd join public.documents doc on doc.id = rd.document_id
  where rd.request_id = dr.id and doc.sent_at is not null
) d
cross join lateral (
  select count(*)::int as reminder_count, max(rm.sent_at) as last_reminder_at
  from public.reminder_requests rr join public.reminders rm on rm.id = rr.reminder_id
  where rr.request_id = dr.id
) r
cross join lateral (
  select max(m.sent_at) as last_client_message_at
  from public.request_messages rqm
  join public.messages m on m.id = rqm.message_id
  join public.client_members mem on mem.client_id = m.client_id and mem.user_id = m.author_id
  where rqm.request_id = dr.id
) cm;

create view public.proposal_status with (security_invoker = true) as
select
  p.id as proposal_id,
  p.client_id,
  case
    when pr.decision is not null then pr.decision::text
    when p.expires_at is not null and p.expires_at <= now() then 'expired'
    else 'pending'
  end as status,
  pr.responded_at
from public.proposals p
left join public.proposal_responses pr on pr.proposal_id = p.id;

-- Un mandat : activation, cycle de vie, paiement, conditions du forfait en vigueur et engagement
-- identity_check (visible par l'administratrice seulement) : none, pending, different_person, same_person
create view public.mandate_status with (security_invoker = true) as
select
  m.id as mandate_id,
  m.client_id,
  case
    when m.activated_at is not null      then 'active'
    when f.completed_at is null          then 'intake_pending'
    when m.welcome_call_done_at is null  then 'call_pending'
    else 'quickbooks_pending'
  end as activation_status,
  case
    when cl.mandate_id is not null then 'closed'
    when p.id is not null        then 'paused'
    else 'open'
  end as lifecycle_status,
  cl.kind as closure_kind,
  lf.lifted_at as closure_lifted_at,
  case
    when rv.outcome is not null then rv.outcome::text
    when exists (select 1 from public.signup_flags sf where sf.mandate_id = m.id) then 'pending'
    else 'none'
  end as identity_check,
  case
    when s.read_only_since is not null   then 'read_only'
    when s.payment_failed_at is not null then 'grace_period'
    else 'ok'
  end as payment_status,
  s.id as subscription_id,
  pp.plan_code,
  pp.recurring_price_cents,
  pp.included_transactions,
  pp.extra_transaction_cents,
  case when s.billing_option in ('monthly_commitment', 'annual')
       then (s.starts_on + interval '12 months')::date end as commitment_ends_on,
  p.skipped_charge_on
from public.mandates m
left join public.mandate_closures cl on cl.mandate_id = m.id
left join public.closure_lifts lf on lf.mandate_id = m.id
left join public.signup_reviews rv on rv.mandate_id = m.id
left join public.intake_forms f on f.mandate_id = m.id
left join public.pauses p on p.mandate_id = m.id and p.ended_at is null
left join public.subscriptions s on s.mandate_id = m.id and s.ended_at is null
left join public.subscription_plan_periods pp
  on pp.subscription_id = s.id
 and daterange(pp.effective_from, pp.effective_to, '[)') @> private.today();

-- État simplifié du dossier (carte d'accueil) et liste des clients de l'administration
create view public.client_overview with (security_invoker = true) as
select
  c.id as client_id,
  c.display_name,
  q.pending_questions,
  r.pending_requests,
  msg.unread_messages,
  case
    when q.pending_questions + r.pending_requests > 0 then 'waiting_on_client'
    else 'in_progress'
  end as month_status
from public.clients c
cross join lateral (
  select count(*)::int as pending_questions
  from public.questions x
  where x.client_id = c.id and x.resolved_at is null
    and not exists (select 1 from public.question_answers a where a.question_id = x.id)
) q
cross join lateral (
  select count(*)::int as pending_requests
  from public.document_requests x
  where x.client_id = c.id and x.processed_at is null and x.canceled_at is null
    and not exists (
      select 1 from public.request_documents rd join public.documents d on d.id = rd.document_id
      where rd.request_id = x.id and d.sent_at is not null)
) r
cross join lateral (
  select count(*)::int as unread_messages
  from public.messages m
  where m.client_id = c.id
    and m.author_id is distinct from auth.uid()
    and not exists (select 1 from public.message_reads mr
                    where mr.message_id = m.id and mr.user_id = auth.uid())
) msg;

-- Les vues héritent des privilèges retirés par défaut : on les accorde.
grant select on public.question_status, public.document_request_status, public.proposal_status,
                public.mandate_status, public.client_overview to authenticated;
