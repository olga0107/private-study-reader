import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL, anon = process.env.SUPABASE_ANON_KEY, service = process.env.SUPABASE_SERVICE_ROLE_KEY
const enabled = Boolean(url && anon && service && process.env.RUN_LIVE_TESTS === '1')
test('live private storage, per-account isolation, CAS conflict, and revoked access', { skip: !enabled }, async () => {
  const options = { auth: { persistSession: false, autoRefreshToken: false } }
  const admin = createClient(url, service, options), guest = createClient(url, anon, options)
  const clients = [], ids = [], prefix = `reader-test-${randomUUID()}`
  const object = `test/${prefix}.json`
  try {
    for (const suffix of ['a', 'b']) {
      const email = `${prefix}-${suffix}@example.com`, password = randomUUID() + 'aA1!'
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      assert.ifError(error); ids.push(data.user.id)
      const client = createClient(url, anon, options)
      const signed = await client.auth.signInWithPassword({ email, password })
      assert.ifError(signed.error); clients.push(client)
    }
    const [a, b] = clients
    assert.ifError((await admin.storage.from('site-content').upload(object, JSON.stringify({ sample: 'private fixture' }), { contentType: 'application/json' })).error)
    assert.ok((await guest.storage.from('site-content').download(object)).error)
    const publicResponse = await fetch(`${url}/storage/v1/object/public/site-content/${object}`)
    assert.notEqual(publicResponse.status, 200)
    assert.equal(await (await a.storage.from('site-content').download(object)).data.text(), '{"sample":"private fixture"}')
    assert.ok((await a.storage.from('site-content').upload('test/unauthorized.json', 'no')).error)
    const args = { p_page_path: '/notes/test-page', p_kind: 'marks', p_payload: [], p_expected_revision: 0 }
    assert.ok((await guest.rpc('save_annotation', args)).error)
    const created = await a.rpc('save_annotation', args)
    assert.ifError(created.error); assert.equal(created.data.ok, true); assert.equal(created.data.row.revision, 1)
    assert.deepEqual((await b.from('annotations').select('*').eq('user_id', ids[0])).data, [])
    assert.ok((await b.from('annotations').insert({ user_id: ids[0], page_path: args.p_page_path, kind: 'ink', payload: {} })).error)
    const race = await Promise.all([a.rpc('save_annotation', { ...args, p_expected_revision: 1, p_payload: [{ note: 'first' }] }),
      a.rpc('save_annotation', { ...args, p_expected_revision: 1, p_payload: [{ note: 'second' }] })])
    assert.equal(race.filter(r => r.data?.ok).length, 1)
    assert.equal(race.filter(r => r.data?.ok === false).length, 1)
    const stale = await a.rpc('save_annotation', { ...args, p_expected_revision: 1 })
    assert.equal(stale.data.ok, false); assert.equal(stale.data.row.revision, 2)
    const bCreated = await b.rpc('save_annotation', args)
    assert.equal(bCreated.data.ok, true); assert.equal(bCreated.data.row.user_id, ids[1])
    const aRows = await a.from('annotations').select('*')
    assert.equal(aRows.data.length, 1); assert.equal(aRows.data[0].user_id, ids[0])
    // Deletion of the last mark is a saved empty snapshot, not a missing write.
    const empty = await a.rpc('save_annotation', { ...args, p_expected_revision: 2 })
    assert.equal(empty.data.ok, true); assert.deepEqual(empty.data.row.payload, [])
    assert.ifError((await admin.auth.admin.updateUserById(ids[0], { ban_duration: '1h' })).error)
    assert.ok((await a.storage.from('site-content').download(object)).error)
    assert.deepEqual((await a.from('annotations').select('*')).data, [])
    assert.ok((await a.rpc('save_annotation', { ...args, p_expected_revision: 3 })).error)
  } finally {
    await admin.storage.from('site-content').remove([object])
    for (const id of ids) await admin.auth.admin.deleteUser(id)
  }
})
