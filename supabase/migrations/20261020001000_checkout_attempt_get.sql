-- Lecture d'une tentative par les Edge Functions (service_role seulement).
-- Tous les accès des fonctions passent par des fonctions SQL : un seul chemin,
-- facile à tester et à restreindre.
create function public.checkout_attempt_get(p_id uuid)
returns setof public.checkout_attempts
language sql stable security definer set search_path = '' as $$
  select * from public.checkout_attempts where id = p_id
$$;

revoke execute on function public.checkout_attempt_get(uuid) from public, anon, authenticated;
grant execute on function public.checkout_attempt_get(uuid) to service_role;
