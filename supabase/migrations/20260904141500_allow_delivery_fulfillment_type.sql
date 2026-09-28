-- orders_fulfillment_type_check verrouillait la colonne à 'PICKUP' en
-- dur -- trouvé en testant la migration précédente en conditions
-- réelles (create_order acceptait DELIVERY, l'insert derrière plantait).
alter table public.orders drop constraint orders_fulfillment_type_check;
alter table public.orders add constraint orders_fulfillment_type_check
  check (fulfillment_type in ('PICKUP', 'DELIVERY'));
