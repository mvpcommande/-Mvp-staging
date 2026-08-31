-- Menu photos are storefront content, same visibility as products/restaurants
-- themselves. Without this, the customer-facing (anon) menu query can't see
-- any row here at all, since the only existing policy requires staff auth.
create policy product_images_public_read
on public.product_images
for select
to anon, authenticated
using (true);
