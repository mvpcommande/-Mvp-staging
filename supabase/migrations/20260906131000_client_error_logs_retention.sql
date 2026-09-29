-- Rétention des logs d'erreurs : purge quotidienne des entrées de plus de
-- 30 jours, pour éviter que client_error_logs gonfle indéfiniment (coût
-- stockage + bruit au diagnostic). Planifié via pg_cron.

create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-client-error-logs') then
    perform cron.unschedule('purge-client-error-logs');
  end if;
end $$;

select cron.schedule(
  'purge-client-error-logs',
  '0 3 * * *',
  $purge$delete from public.client_error_logs where created_at < now() - interval '30 days'$purge$
);
