-- Crée le secret du dispatcher RusHour dans Supabase Vault, généré DANS la
-- base (32 octets aléatoires, hex). Idempotent : ne remplace jamais un
-- secret existant. La valeur n'est jamais affichée : seul l'identifiant
-- Vault est renvoyé.
--
-- Rotation : select vault.update_secret(
--   (select id from vault.secrets where name = 'rushour_dispatch_secret'),
--   encode(extensions.gen_random_bytes(32), 'hex'));
-- (pg_cron/pg_net et l'Edge Function lisent la nouvelle valeur au prochain appel.)

select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'rushour_dispatch_secret',
  'Secret du dispatcher RusHour (x-rushour-dispatch-secret)'
) as created_secret_id
where not exists (select 1 from vault.secrets where name = 'rushour_dispatch_secret');
