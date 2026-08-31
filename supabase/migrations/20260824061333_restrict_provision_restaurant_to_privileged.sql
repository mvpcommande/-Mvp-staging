-- provision_restaurant() currently lets ANY signed-up user create a new
-- restaurant tenant. Restrict it to service_role (i.e. done deliberately,
-- not via the public API) until a real vetted onboarding flow exists.
revoke execute on function public.provision_restaurant(text, text, text, text) from authenticated;
revoke execute on function public.provision_restaurant(text, text, text, text) from anon;
