export async function signInAdmin(client, email, password) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function getAdminSession(client) {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signOutAdmin(client) {
  const { error } = await client.auth.signOut();
  if (error) throw error;
}
