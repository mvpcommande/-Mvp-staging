insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('restaurant-media','restaurant-media',false,10485760,ARRAY['image/jpeg','image/png','image/webp','image/avif','application/pdf','text/csv'])
on conflict (id) do update set public=false, file_size_limit=10485760, allowed_mime_types=excluded.allowed_mime_types;

create policy restaurant_media_select on storage.objects for select to authenticated using (
  bucket_id = 'restaurant-media'
  and (storage.foldername(name))[1]::uuid = public.current_restaurant_id()
);

create policy restaurant_media_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'restaurant-media'
  and (storage.foldername(name))[1]::uuid = public.current_restaurant_id()
);

create policy restaurant_media_update on storage.objects for update to authenticated using (
  bucket_id = 'restaurant-media'
  and (storage.foldername(name))[1]::uuid = public.current_restaurant_id()
) with check (
  bucket_id = 'restaurant-media'
  and (storage.foldername(name))[1]::uuid = public.current_restaurant_id()
);

create policy restaurant_media_delete on storage.objects for delete to authenticated using (
  bucket_id = 'restaurant-media'
  and (storage.foldername(name))[1]::uuid = public.current_restaurant_id()
);
