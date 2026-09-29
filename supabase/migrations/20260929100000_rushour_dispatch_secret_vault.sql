-- ============================================================================
-- BLOC RUSHOUR 1.1 — SECRET DU DISPATCHER DANS SUPABASE VAULT
-- ============================================================================
--
-- L'Edge Function rushour-dispatch-order n'accepte un appel que s'il porte
-- l'en-tête x-rushour-dispatch-secret. Source de vérité recommandée : le
-- secret Vault 'rushour_dispatch_secret', déjà lu par pg_cron/pg_net pour
-- appeler la fonction. Un seul secret, généré dans la base, jamais affiché,
-- jamais committé, jamais exposé au navigateur.
--
-- rushour_verify_dispatch_secret(candidate) :
--   NULL  -> secret non configuré (la fonction répond 503, fail closed)
--   TRUE  -> candidat valide
--   FALSE -> candidat invalide
-- Comparaison d'empreintes sha256 (pas de comparaison caractère par
-- caractère du secret). EXECUTE réservé à service_role.
--
-- Création du secret (hors migration, par environnement) :
--   supabase/ops/rushour_dispatch_secret.sql
-- ============================================================================

begin;

create or replace function public.rushour_verify_dispatch_secret(p_candidate text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  select ds.decrypted_secret into v_secret
  from vault.decrypted_secrets ds
  where ds.name = 'rushour_dispatch_secret'
  limit 1;

  if v_secret is null or char_length(v_secret) < 32 then
    return null;
  end if;
  if p_candidate is null then
    return false;
  end if;
  return pg_catalog.sha256(pg_catalog.convert_to(p_candidate, 'UTF8'))
       = pg_catalog.sha256(pg_catalog.convert_to(v_secret, 'UTF8'));
end;
$$;

revoke all on function public.rushour_verify_dispatch_secret(text) from public, anon, authenticated;
grant execute on function public.rushour_verify_dispatch_secret(text) to service_role;

commit;
