-- ROLLBACK de 20260929100000_rushour_dispatch_secret_vault.sql
-- Le secret Vault lui-même n'est pas supprimé automatiquement (décision
-- d'exploitation) : select vault.delete_secret? -> via le dashboard Vault.
-- Sans la fonction, l'Edge Function répond 503 si RUSHOUR_DISPATCH_SECRET
-- n'est pas défini dans ses secrets (fail closed).
begin;
drop function if exists public.rushour_verify_dispatch_secret(text);
commit;
