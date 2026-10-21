-- Retour du site après Stripe : lecture seulement, service_role exclusivement.
-- Aucun SELECT * : ni coordonnées, ni motif de refus dans ce port de consultation.
create function public.checkout_attempt_status_by_session(p_session_id text)
returns table (
  id uuid,
  stripe_session_id text,
  granted_quote jsonb,
  paid_at timestamptz,
  paid_amount_cents integer,
  completed_at timestamptz,
  rejected_at timestamptz,
  refund_id text,
  refund_amount_cents integer,
  dossier_exists boolean
)
language sql stable security definer set search_path = '' as $$
  select a.id, a.stripe_session_id, a.granted_quote, a.paid_at, a.paid_amount_cents,
         a.completed_at, a.rejected_at, a.refund_id, a.refund_amount_cents,
         exists (
           select 1 from public.subscriptions s
           join public.mandates m on m.id = s.mandate_id
           join public.clients c on c.id = m.client_id
           where s.stripe_subscription_id = a.stripe_subscription_id
         )
  from public.checkout_attempts a
  where a.stripe_session_id = p_session_id;
$$;

revoke execute on function public.checkout_attempt_status_by_session(text) from public, anon, authenticated;
grant execute on function public.checkout_attempt_status_by_session(text) to service_role;
