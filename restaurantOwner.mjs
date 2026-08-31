/**
 * Compte propriétaire de restaurant : inscription, connexion,
 * création de son propre restaurant (self_provision_restaurant),
 * gestion de son menu et de ses horaires - sans intervention
 * manuelle de Kevin.
 *
 * Séparé de customerAccount.mjs : un propriétaire n'est pas un
 * client (pas de ligne "customers", pas d'historique de commandes),
 * c'est un modèle de données différent.
 */

export function isValidEmail(value) {
  return (
    typeof value === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  );
}

export function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export async function signUpOwner(client, { email, password }) {
  const { data, error } = await client.auth.signUp({
    email: String(email).trim(),
    password
  });

  if (error) {
    throw error;
  }

  /*
   * Même bug corrigé que dans customerAccount.mjs : Supabase renvoie
   * data.user.id même quand la confirmation email est en attente -
   * seule data.session est absente dans ce cas. C'est exactement ce
   * qui a cassé la création de restaurant de Kevin : le code
   * pensait l'inscription pleinement réussie et tentait de créer le
   * restaurant sans session valide, d'où l'erreur générique.
   */
  return { pendingConfirmation: !data?.session };
}

export async function signInOwner(client, { email, password }) {
  const { data, error } = await client.auth.signInWithPassword({
    email: String(email).trim(),
    password
  });

  if (error) {
    throw error;
  }

  return data;
}

export async function signOutOwner(client) {
  const { error } = await client.auth.signOut();
  if (error) {
    throw error;
  }
}

/**
 * Restaurant déjà créé par l'utilisateur connecté, s'il existe.
 * Repose sur restaurant_members plutôt que sur les app_metadata du
 * JWT en cache, qui ne se rafraîchissent qu'à la reconnexion.
 */
export async function getOwnedRestaurant(client) {
  const {
    data: { user }
  } = await client.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: membership, error: membershipError } = await client
    .from('restaurant_members')
    .select('restaurant_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (membershipError) {
    throw membershipError;
  }

  if (!membership) {
    return null;
  }

  const { data: restaurant, error: restaurantError } = await client
    .from('restaurants')
    .select('*')
    .eq('id', membership.restaurant_id)
    .single();

  if (restaurantError) {
    throw restaurantError;
  }

  return restaurant;
}

export async function createOwnedRestaurant(client, fields) {
  const { data, error } = await client.rpc(
    'self_provision_restaurant',
    {
      p_name: fields.name,
      p_slug: fields.slug,
      p_sector: fields.sector,
      p_phone: fields.phone || null,
      p_address_street: fields.addressStreet || null,
      p_address_postal_code: fields.addressPostalCode || null,
      p_address_city: fields.addressCity || null
    }
  );

  if (error) {
    throw error;
  }

  /*
   * self_provision_restaurant() vient de poser role/restaurant_id
   * sur auth.users, mais le jeton déjà en main dans le navigateur a
   * été émis AVANT et ne les contient pas encore - current_restaurant_id()
   * côté base continuerait de lire l'ancienne valeur (ou aucune)
   * jusqu'au prochain renouvellement naturel du jeton. Sans ce
   * rafraîchissement forcé, le tout premier "ajouter un produit"
   * échoue systématiquement pour n'importe quel nouveau restaurant,
   * pas seulement celui-ci - exactement ce qui vient de bloquer Kevin.
   */
  const { error: refreshError } = await client.auth.refreshSession();

  if (refreshError) {
    throw refreshError;
  }

  return data;
}

export async function updateOpeningHours(client, restaurantId, openingHours) {
  const { data: current, error: readError } = await client
    .from('restaurants')
    .select('settings')
    .eq('id', restaurantId)
    .single();

  if (readError) {
    throw readError;
  }

  const { error } = await client
    .from('restaurants')
    .update({
      settings: {
        ...(current?.settings || {}),
        opening_hours: openingHours
      }
    })
    .eq('id', restaurantId);

  if (error) {
    throw error;
  }
}

export async function getOwnProducts(client, restaurantId) {
  const { data, error } = await client
    .from('products')
    .select('*, product_images(id, public_url, is_primary)')
    .eq('restaurant_id', restaurantId)
    .order('sort_order', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

/**
 * Envoie une photo produit dans le stockage Supabase (bucket public
 * en lecture, écriture réservée au restaurant propriétaire) plutôt
 * que dans le dépôt git - aucune reconstruction ni redéploiement
 * nécessaire, contrairement au procédé manuel utilisé jusqu'ici pour
 * Caz Food.
 */
export async function uploadProductPhoto(client, restaurantId, productId, file) {
  const extension = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${restaurantId}/${productId}-${Date.now()}.${extension}`;

  const { error: uploadError } = await client.storage
    .from('restaurant-media')
    .upload(path, file, { upsert: false });

  if (uploadError) {
    throw uploadError;
  }

  const {
    data: { publicUrl }
  } = client.storage.from('restaurant-media').getPublicUrl(path);

  const { error: insertError } = await client
    .from('product_images')
    .insert({
      restaurant_id: restaurantId,
      product_id: productId,
      storage_path: path,
      public_url: publicUrl,
      is_primary: true,
      sort_order: 0
    });

  if (insertError) {
    throw insertError;
  }

  return publicUrl;
}

export async function addProduct(client, restaurantId, fields) {
  const { data, error } = await client
    .from('products')
    .insert({
      restaurant_id: restaurantId,
      name: fields.name,
      category: fields.category || 'Autres',
      description: fields.description || '',
      price_cents: Math.round(Number(fields.price) * 100),
      is_active: true,
      sort_order: fields.sortOrder ?? 0,
      options: {
        meat: Boolean(fields.meat),
        sauce: Boolean(fields.sauce),
        drink: Boolean(fields.drink),
        multipleMeat: Boolean(fields.multipleMeat),
        tripleMeat: Boolean(fields.tripleMeat),
        emoji: fields.emoji || '🍽️'
      }
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateRestaurantColor(client, restaurantId, color) {
  const { error } = await client
    .from('restaurants')
    .update({ primary_color: color })
    .eq('id', restaurantId);

  if (error) {
    throw error;
  }
}

export async function uploadRestaurantLogo(client, restaurantId, file) {
  const extension = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${restaurantId}/logo-${Date.now()}.${extension}`;

  const { error: uploadError } = await client.storage
    .from('restaurant-media')
    .upload(path, file, { upsert: false });

  if (uploadError) {
    throw uploadError;
  }

  const {
    data: { publicUrl }
  } = client.storage.from('restaurant-media').getPublicUrl(path);

  const { error: updateError } = await client
    .from('restaurants')
    .update({ logo_url: publicUrl })
    .eq('id', restaurantId);

  if (updateError) {
    throw updateError;
  }

  return publicUrl;
}

export async function toggleProductActive(client, productId, isActive) {
  const { error } = await client
    .from('products')
    .update({ is_active: isActive })
    .eq('id', productId);

  if (error) {
    throw error;
  }
}

export async function deleteProduct(client, productId) {
  const { error } = await client
    .from('products')
    .delete()
    .eq('id', productId);

  if (error) {
    throw error;
  }
}
