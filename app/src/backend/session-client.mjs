import { createClient } from '@supabase/supabase-js'

export async function accountClient(auth, url, key, userId, isCurrent) {
  const { data: { session }, error } = await auth.getSession()
  if (!isCurrent()) return null
  if (error) throw error
  if (!session || session.user.id !== userId) throw Error('账号已变更，请重新同步。')
  // The shared SDK resolves tokens asynchronously; pin this verified account's JWT.
  const token = session.access_token
  return createClient(url, key, { accessToken: async () => token })
}
