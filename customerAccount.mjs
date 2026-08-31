/**
 * Compte client FOODATOI : inscription, connexion, historique de
 * commandes, consentement marketing, suppression RGPD.
 *
 * Séparé de supabaseStore.mjs (qui gère la création de commande et
 * le temps réel) parce que c'est un domaine différent : identité et
 * données personnelles du client, pas le flux de commande lui-même.
 */

export function isValidEmail(value) {
  return (
    typeof value === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  );
}

export async function signUpCustomer(
  client,
  restaurantId,
  { email, password, name, phone, marketingEmail, marketingSms }
) {
  const { data: authData, error: authError } =
    await client.auth.signUp({
      email: String(email).trim(),
      password
    });

  if (authError) {
    throw authError;
  }

  const userId = authData?.user?.id;

  if (!authData?.session) {
    // Confirmation email requise avant que la session existe. Bug
    // réel corrigé ici : Supabase renvoie authData.user.id même
    // quand la confirmation est en attente - seule authData.session
    // est absente dans ce cas. Vérifier user.id à la place laissait
    // croire que l'inscription avait pleinement réussi et enchaînait
    // sur la création de la fiche client sans session valide.
    return { pendingConfirmation: true };
  }

  const { data: customer, error: customerError } = await client
    .from('customers')
    .insert({
      restaurant_id: restaurantId,
      auth_user_id: userId,
      name: String(name || '').trim() || null,
      phone: String(phone || '').trim() || null,
      email: String(email).trim()
    })
    .select()
    .single();

  if (customerError) {
    throw customerError;
  }

  const consentRows = [
    { channel: 'EMAIL', granted: Boolean(marketingEmail) },
    { channel: 'SMS', granted: Boolean(marketingSms) }
  ].map((row) => ({
    restaurant_id: restaurantId,
    customer_id: customer.id,
    channel: row.channel,
    granted: row.granted,
    source: 'signup',
    granted_at: row.granted ? new Date().toISOString() : null
  }));

  const { error: consentError } = await client
    .from('marketing_consents')
    .insert(consentRows);

  if (consentError) {
    throw consentError;
  }

  return { pendingConfirmation: false, customer };
}

export async function signInCustomer(client, { email, password }) {
  const { data, error } = await client.auth.signInWithPassword({
    email: String(email).trim(),
    password
  });

  if (error) {
    throw error;
  }

  return data;
}

export async function signOutCustomer(client) {
  const { error } = await client.auth.signOut();

  if (error) {
    throw error;
  }
}

export async function getCustomerProfile(client, restaurantId) {
  const {
    data: { user }
  } = await client.auth.getUser();

  if (!user) {
    return null;
  }

  const { data, error } = await client
    .from('customers')
    .select('*')
    .eq('auth_user_id', user.id)
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function getCustomerOrders(client, customerId) {
  const { data, error } = await client
    .from('orders')
    .select(
      'id, order_number, status, total_cents, pickup_time, created_at, order_items(product_name, quantity, line_total_cents)'
    )
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function getCustomerConsents(client, customerId) {
  const { data, error } = await client
    .from('marketing_consents')
    .select('channel, granted')
    .eq('customer_id', customerId);

  if (error) {
    throw error;
  }

  return data ?? [];
}

export async function setCustomerConsent(
  client,
  { restaurantId, customerId, channel, granted }
) {
  const { error: upsertError } = await client
    .from('marketing_consents')
    .upsert(
      {
        restaurant_id: restaurantId,
        customer_id: customerId,
        channel,
        granted,
        source: 'account',
        granted_at: granted ? new Date().toISOString() : null,
        withdrawn_at: granted ? null : new Date().toISOString()
      },
      { onConflict: 'restaurant_id,customer_id,channel' }
    );

  if (upsertError) {
    throw upsertError;
  }

  const { error: eventError } = await client
    .from('marketing_consent_events')
    .insert({
      restaurant_id: restaurantId,
      customer_id: customerId,
      channel,
      granted,
      source: 'account'
    });

  if (eventError) {
    throw eventError;
  }
}

export async function deleteCustomerAccount(client) {
  const { error } = await client.rpc('delete_customer_account');

  if (error) {
    throw error;
  }

  await signOutCustomer(client);
}
