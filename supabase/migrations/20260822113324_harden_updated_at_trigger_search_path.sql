create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
