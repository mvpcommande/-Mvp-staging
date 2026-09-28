-- ROLLBACK prêt à exécuter pour
-- supabase/migrations/20260922080100_enforce_order_status_transitions.sql
--
-- NON exécuté par cet agent. À exécuter manuellement, uniquement si un
-- problème est constaté après application de PB-03 en production, et
-- uniquement après autorisation explicite.
--
-- Ce fichier n'est PAS dans supabase/migrations/ pour ne jamais être
-- ramassé automatiquement par le système de migration comme une
-- migration à appliquer.

drop trigger if exists enforce_order_status_transition_trigger on public.orders;
drop function if exists public.enforce_order_status_transition();

-- Vérification post-rollback : aucun trigger de validation de transition
-- ne doit plus exister sur orders (retour à l'état pré-Bloc 5) :
--   select tgname from pg_trigger
--   where tgrelid = 'public.orders'::regclass and not tgisinternal;
-- Ne doit PAS lister enforce_order_status_transition_trigger.
