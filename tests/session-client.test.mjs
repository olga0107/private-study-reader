import test from 'node:test'
import assert from 'node:assert/strict'
import { accountClient } from '../app/src/backend/session-client.mjs'

const session = id => ({ user: { id }, access_token: `token-${id}` })
test('account changes during token lookup cannot dispatch the previous account payload', async () => {
  let resolve
  const auth = { getSession: () => new Promise(done => { resolve = done }) }
  const pending = accountClient(auth, 'https://example.invalid', 'public-key', 'a', () => true)
  resolve({ data: { session: session('b') }, error: null })
  await assert.rejects(pending, /账号已变更/)
})

test('invalidated sync stops even if its previous session lookup completes', async () => {
  let resolve, current = true
  const auth = { getSession: () => new Promise(done => { resolve = done }) }
  const pending = accountClient(auth, 'https://example.invalid', 'public-key', 'a', () => current)
  current = false
  resolve({ data: { session: session('a') }, error: null })
  assert.equal(await pending, null)
})

test('SDK dispatch keeps the verified token when the shared session changes later', async () => {
  let active = session('a'), lookups = 0
  const auth = { getSession: async () => { lookups++; return { data: { session: active }, error: null } } }
  const originalFetch = globalThis.fetch, sent = []
  globalThis.fetch = async (_url, options) => {
    sent.push({ authorization: new Headers(options.headers).get('Authorization'), body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const client = await accountClient(auth, 'https://example.invalid', 'public-key', 'a', () => true)
    active = session('b')
    const { error } = await client.rpc('save_annotation', { p_payload: ['private-a-note'] })
    assert.ifError(error)
    assert.equal(lookups, 1)
    assert.deepEqual(sent, [{ authorization: 'Bearer token-a', body: { p_payload: ['private-a-note'] } }])
  } finally { globalThis.fetch = originalFetch }
})
