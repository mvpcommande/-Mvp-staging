export async function getLoyaltyProgram(client, restaurantId) {
  const { data, error } = await client
    .from('loyalty_programs')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function upsertLoyaltyProgram(client, restaurantId, fields) {
  const existing = await getLoyaltyProgram(client, restaurantId);

  const payload = {
    restaurant_id: restaurantId,
    name: fields.name,
    is_active: Boolean(fields.isActive),
    earn_mode: fields.earnMode || 'points_per_euro',
    points_per_euro: Number(fields.pointsPerEuro) || 1
  };

  const query = existing
    ? client.from('loyalty_programs').update(payload).eq('id', existing.id)
    : client.from('loyalty_programs').insert(payload);

  const { error } = await query;

  if (error) {
    throw error;
  }
}

export async function getLoyaltyRewards(client, restaurantId) {
  const { data, error } = await client
    .from('loyalty_rewards')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('cost_points', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function addLoyaltyReward(client, restaurantId, fields) {
  const { error } = await client.from('loyalty_rewards').insert({
    restaurant_id: restaurantId,
    name: fields.name,
    description: fields.description || null,
    cost_points: Number(fields.costPoints),
    reward_type: 'MANUAL',
    reward_value: {}
  });

  if (error) {
    throw error;
  }
}

export async function toggleLoyaltyReward(client, rewardId, isActive) {
  const { error } = await client
    .from('loyalty_rewards')
    .update({ is_active: isActive })
    .eq('id', rewardId);

  if (error) {
    throw error;
  }
}

export async function deleteLoyaltyReward(client, rewardId) {
  const { error } = await client.from('loyalty_rewards').delete().eq('id', rewardId);

  if (error) {
    throw error;
  }
}

/**
 * Solde du client connecté pour un restaurant donné - null s'il n'a
 * pas encore de compte fidélité (aucune commande "Prête" encore
 * passée depuis l'activation du programme).
 */
export async function getMyLoyaltyAccount(client, restaurantId) {
  const {
    data: { user }
  } = await client.auth.getUser();

  if (!user) {
    return null;
  }

  const { data, error } = await client
    .from('loyalty_accounts')
    .select('balance_points, lifetime_earned_points, lifetime_redeemed_points')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function redeemLoyaltyReward(client, rewardId) {
  const { data, error } = await client
    .rpc('redeem_loyalty_reward', { p_reward_id: rewardId })
    .single();

  if (error) {
    throw error;
  }

  return data;
}
