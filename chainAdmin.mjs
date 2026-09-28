export async function getMyChain(client) {
  const { data, error } = await client
    .from('chains')
    .select('*')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function getChainDashboard(client, chainId) {
  const { data, error } = await client.rpc('get_chain_dashboard', {
    p_chain_id: chainId
  });

  if (error) {
    throw error;
  }

  return data ?? [];
}
