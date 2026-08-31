begin;
revoke execute on function public.prevent_loyalty_ledger_mutation() from public, anon, authenticated;
revoke execute on function public.redeem_loyalty_reward(uuid) from public, anon;
grant execute on function public.redeem_loyalty_reward(uuid) to authenticated;
commit;
