-- ============================================================================
-- MIGRATION À VALIDER — NON APPLIQUÉE PAR CET AGENT.
-- Créée dans le cadre de l'audit de durcissement Bloc 5 (hardening
-- pilote), à relire et appliquer manuellement après vérification.
-- ============================================================================
--
-- CANCELLED_DECISION (Bloc 5.1, revue statique, corrige une erreur de la
-- version précédente de cette migration) :
--
--   La version précédente de ce fichier autorisait NEW/ACCEPTED/PREPARING
--   -> CANCELLED en la présentant comme "une copie fidèle de
--   orderWorkflow.mjs". C'est FAUX et corrigé ici :
--
--     - orderWorkflow.mjs::transitions (source citée par admin.js
--       lui-même comme la machine à états de référence) est :
--         { NEW: ['ACCEPTED'], ACCEPTED: ['PREPARING'],
--           PREPARING: ['READY'], READY: [] }
--       CANCELLED n'y figure NULLE PART, ni comme état ni comme cible.
--     - grep exhaustif de ce repo (`'CANCELLED'`/`"CANCELLED"` dans
--       *.js/*.mjs) : aucun appel à updateStatus()/supabaseStore, aucun
--       RPC, aucune action admin.js n'écrit jamais CANCELLED. Les deux
--       seules occurrences hors commentaires/libellés sont
--       admin.js:69 (COLUMN_LABELS, un libellé d'affichage pour le cas
--       où la valeur existerait déjà en base) et
--       adminFeatures.mjs:246 (un filtre en LECTURE qui exclut
--       CANCELLED d'un calcul, jamais une écriture).
--     - admin.js documente lui-même (commentaire ligne ~111) que
--       CANCELLED "existe côté base... mais n'a aucune transition
--       cliquable ici".
--
--   Autoriser CANCELLED comme cible aurait donc été l'ajout d'une
--   RÈGLE MÉTIER INVENTÉE, non couverte par aucun chemin applicatif
--   actuel -- explicitement interdit par les règles du Bloc 5
--   ("ne jamais inventer de donnée/règle"). Le trigger ci-dessous
--   protège donc EXACTEMENT et UNIQUEMENT les transitions qui existent
--   réellement aujourd'hui :
--
--     NEW -> ACCEPTED
--     ACCEPTED -> PREPARING
--     PREPARING -> READY
--     READY -> (aucune, terminal)
--
--   Si un besoin métier d'annulation existe, il doit être spécifié et
--   implémenté (UI + RPC/policy dédiée) séparément, puis cette migration
--   étendue en conséquence -- pas l'inverse.
--
-- ---------------------------------------------------------------------------
--
-- MISE À JOUR POST-VÉRIFICATION LIVE (TEST LIVE, projet Supabase Foodatoi
-- réel) -- CE GAP EST CONFIRMÉ EXPLOITABLE EN PRODUCTION ACTUELLEMENT,
-- RECLASSÉ P0 :
--
--   1. Inspection en lecture seule (pg_trigger, pg_get_triggerdef) : les
--      triggers réellement présents sur public.orders en production sont
--      orders_link_customer (BEFORE INSERT), orders_set_updated_at
--      (BEFORE UPDATE), orders_status_event (AFTER UPDATE OF status --
--      appelle log_order_status_change, qui journalise uniquement, sans
--      validation) et orders_loyalty_on_ready (AFTER UPDATE OF status).
--      AUCUN trigger ne valide la transition. orders_admin_update.with
--      check ne valide que l'appartenance de la nouvelle valeur à
--      l'ensemble {NEW, ACCEPTED, PREPARING, READY, CANCELLED}, exactement
--      comme documenté plus bas -- confirmé sur la policy live elle-même.
--
--   2. TEST COMPORTEMENTAL LIVE, exécuté sur une commande de test créée et
--      nettoyée dans ce même audit (restaurant fixture demo-charge,
--      commande supprimée avec order_items/order_events après le test,
--      suppression vérifiée par comptage à zéro) :
--        - `update orders set status = 'READY' where id = '<commande NEW>'`
--          a RÉUSSI -- saut direct NEW -> READY sans passer par ACCEPTED
--          ni PREPARING.
--        - Sur cette même commande désormais READY,
--          `update orders set status = 'NEW' where id = '<...>'`
--          a ÉGALEMENT RÉUSSI -- retour en arrière READY -> NEW, sans
--          aucune résistance serveur.
--      Les deux résultats confirment intégralement, de façon
--      comportementale et pas seulement structurelle, le scénario décrit
--      plus bas.
--
--   L'utilisateur ayant explicitement listé "mutation de statut non
--   autorisée" comme déclencheur P0 pour ce Bloc 5, ce problème est donc
--   reclassé P0 (initialement documenté P1 lors de la revue statique,
--   qui n'avait pas accès à un test comportemental live). Conformément
--   à la règle STOP du Bloc 5 : cette migration N'A PAS été appliquée en
--   production par cet agent et reste en attente d'approbation explicite
--   avant toute application.
--
-- ---------------------------------------------------------------------------
-- PROBLÈME D'ORIGINE, TEL QUE DOCUMENTÉ LORS DE LA REVUE STATIQUE
-- (conservé ci-dessous pour traçabilité) :
-- ---------------------------------------------------------------------------
--
-- PROBLÈME (P1 au moment de la revue statique -- reclassé P0, voir
-- mise à jour ci-dessus) :
--
-- orders_admin_update.with check (20260822113258_lock_down_order_tenant_isolation.sql)
-- vérifie que le nouveau statut appartient à l'ensemble valide
-- {NEW, ACCEPTED, PREPARING, READY, CANCELLED}, mais ne vérifie JAMAIS
-- que la transition depuis le statut ACTUEL de la ligne est légitime.
-- Le seul endroit qui connaît la machine à états réelle
-- (NEW -> ACCEPTED -> PREPARING -> READY, terminal) est côté client,
-- dans orderWorkflow.mjs (transitions), dupliqué une seconde fois de
-- façon indépendante dans admin.js::advance(). Rien ne l'impose côté
-- serveur.
--
-- IMPACT DÉMONTRÉ (Phase 5 de l'audit — concurrence comptoir) :
--
-- Scénario réaliste avec deux appareils employés sur le même
-- restaurant (tablette A et tablette B), sans qu'aucun des deux ne
-- soit malveillant :
--   1. A et B affichent tous deux la même commande, statut PREPARING.
--   2. A clique "Marquer prête" -> UPDATE ... SET status = 'READY'.
--      Le serveur accepte (READY est un statut valide). La commande
--      est maintenant READY en base.
--   3. B, dont l'onglet n'a pas encore reçu l'événement Realtime
--      (déconnexion momentanée, onglet resté en arrière-plan...),
--      affiche encore PREPARING et clique lui aussi sur son propre
--      bouton "Marquer prête" -- mais B calcule son "next" à partir
--      de SA valeur affichée obsolète. Rien n'empêche non plus B de
--      renvoyer, par un bug futur ou un replay de requête, un statut
--      antérieur : le serveur accepterait tout aussi bien
--      READY -> NEW ou READY -> PREPARING, une régression silencieuse
--      qui ferait "reculer" une commande déjà prête aux yeux de la
--      cuisine.
-- Aucune donnée cross-tenant n'est concernée, aucun prix n'est
-- affecté, aucune commande n'est dupliquée -- d'où un classement P1
-- (fiabilité opérationnelle) plutôt que P0.
--
-- CORRECTIF PROPOSÉ :
--
-- Un trigger BEFORE UPDATE qui rejette toute transition de statut qui
-- ne correspond pas exactement à la machine à états déjà définie côté
-- client dans orderWorkflow.mjs. Aucune nouvelle machine à états n'est
-- inventée : celle-ci est une copie fidèle de orderWorkflow.mjs,
-- appliquée une seconde fois côté serveur (défense en profondeur, pas
-- une nouvelle règle métier). Voir CANCELLED_DECISION en tête de
-- fichier : CANCELLED n'est PAS incluse comme cible autorisée, faute
-- de tout chemin applicatif actuel qui l'écrirait.
--
-- Transitions autorisées :
--   NEW       -> ACCEPTED
--   ACCEPTED  -> PREPARING
--   PREPARING -> READY
--   READY     -> (aucune, terminal, comme aujourd'hui côté client)
--
-- RISQUE SI NON CORRIGÉ : régression silencieuse de statut sous
-- concurrence multi-appareils, CONFIRMÉE EXPLOITABLE EN PRODUCTION
-- (TEST LIVE ci-dessus) -- P0.
-- RISQUE DE CE CORRECTIF : un client (admin.js) qui enverrait déjà
-- une transition invalide échouerait désormais avec une erreur
-- explicite au lieu de réussir silencieusement -- comportement
-- strictement plus sûr. Aucun chemin actuel de admin.js ne dépend
-- d'une transition non listée ci-dessus (vérifié par revue statique
-- de advance()/toggleDelivery() dans admin.js : le seul enchaînement
-- utilisé est NEW->ACCEPTED->PREPARING->READY, un par un).
--
-- ROLLBACK (SQL exact, prêt à exécuter -- également disponible en fichier
-- autonome : supabase/rollbacks/rollback_20260922080100_enforce_order_status_transitions.sql) :
--   drop trigger if exists enforce_order_status_transition_trigger on public.orders;
--   drop function if exists public.enforce_order_status_transition();
--
-- VÉRIFICATION MANUELLE (à exécuter sur une branche de dev Supabase,
-- jamais en production) :
--
--   -- Doit RÉUSSIR (transition valide) :
--   update orders set status = 'ACCEPTED' where id = '<commande NEW réelle>';
--
--   -- Doit ÉCHOUER avec INVALID_STATUS_TRANSITION (saut direct) :
--   update orders set status = 'READY' where id = '<commande NEW réelle>';
--
--   -- Doit ÉCHOUER avec INVALID_STATUS_TRANSITION (retour en arrière) :
--   update orders set status = 'PREPARING' where id = '<commande READY réelle>';
--
--   -- Doit ÉCHOUER avec INVALID_STATUS_TRANSITION (CANCELLED non autorisée
--   -- par cette migration, voir CANCELLED_DECISION) :
--   update orders set status = 'CANCELLED' where id = '<commande ACCEPTED réelle>';
--
--   -- Doit RÉUSSIR (update d'une autre colonne, status inchangé) :
--   update orders set notes = 'test' where id = '<commande NEW réelle>';
--
-- ============================================================================

create or replace function public.enforce_order_status_transition()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_allowed boolean := false;
begin
  if new.status is distinct from old.status then
    v_allowed := case old.status
      when 'NEW' then new.status = 'ACCEPTED'
      when 'ACCEPTED' then new.status = 'PREPARING'
      when 'PREPARING' then new.status = 'READY'
      else false
    end;

    if not v_allowed then
      raise exception 'INVALID_STATUS_TRANSITION: % -> %', old.status, new.status;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_order_status_transition_trigger on public.orders;

create trigger enforce_order_status_transition_trigger
before update on public.orders
for each row
execute function public.enforce_order_status_transition();
