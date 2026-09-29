-- ============================================================================
-- ORDONNANCEMENT RUSHOUR — STAGING UNIQUEMENT (script d'exploitation, PAS une
-- migration : il contient une URL d'environnement et lit un secret Vault).
--
-- Choix : pg_cron (déjà utilisé par Foodatoi, migration 20260906131000).
--   - rushour-reconcile-staging : SQL pur, toutes les 2 min, aucun réseau.
--   - rushour-dispatch-staging  : pg_net -> Edge Function, chaque minute.
-- Pourquoi pas un polling navigateur : le rattrapage doit tourner même
-- quand aucun comptoir n'est ouvert, et le secret du worker ne doit
-- jamais quitter le serveur.
--
-- PRÉ-REQUIS (vérifiés par le script, qui s'arrête sinon) :
--   1. exécuté sur le projet STAGING Foodatoi (kkhlpeqherxfdnilewkp),
--      jamais sur ffuykessameuonpnyiyc (production) ;
--   2. migrations 20260928090000 et 20260929090000 appliquées ;
--   3. extensions pg_cron et pg_net actives ;
--   4. secret Vault 'rushour_dispatch_secret' créé AVANT, hors de ce fichier :
--        select vault.create_secret('<valeur>', 'rushour_dispatch_secret');
--      (même valeur que le secret RUSHOUR_DISPATCH_SECRET de l'Edge Function ;
--      ne jamais la committer ni la coller dans un ticket).
--
-- Usage : psql "$STAGING_DB_URL" -v project_ref=kkhlpeqherxfdnilewkp -f ce_fichier
-- ============================================================================

\set ON_ERROR_STOP on

-- Les variables psql ne sont PAS interpolées dans un bloc DO : garde-fou
-- évalué côté psql.
select (:'project_ref' = 'kkhlpeqherxfdnilewkp') as is_staging \gset
\if :is_staging
\else
  \echo 'REFUS : ce script ne cible que le staging Foodatoi (kkhlpeqherxfdnilewkp)'
  \quit
\endif

do $$
begin
  if to_regproc('public.rushour_reconcile') is null then
    raise exception 'Migration 20260929090000 absente';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron')
     or not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_cron et pg_net requis';
  end if;
  if not exists (select 1 from vault.secrets where name = 'rushour_dispatch_secret') then
    raise exception 'Secret Vault rushour_dispatch_secret absent';
  end if;
end $$;

select cron.unschedule(jobname) from cron.job
where jobname in ('rushour-reconcile-staging', 'rushour-dispatch-staging');

select cron.schedule(
  'rushour-reconcile-staging',
  '*/2 * * * *',
  $job$select public.rushour_reconcile(interval '24 hours', 200)$job$
);

select cron.schedule(
  'rushour-dispatch-staging',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://kkhlpeqherxfdnilewkp.supabase.co/functions/v1/rushour-dispatch-order',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-rushour-dispatch-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'rushour_dispatch_secret')
    ),
    body := '{"limit": 10}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);

-- Vérification :
select jobname, schedule, active from cron.job where jobname like 'rushour-%' order by jobname;
-- Exécutions : select * from cron.job_run_details where jobid in
--   (select jobid from cron.job where jobname like 'rushour-%') order by start_time desc limit 20;
-- Retrait : select cron.unschedule('rushour-dispatch-staging'); select cron.unschedule('rushour-reconcile-staging');
