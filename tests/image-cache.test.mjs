import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageCache } from '../app/src/backend/image-cache.mjs'

test('revisiting an image reuses bytes, while another content release fetches new bytes', async () => {
  const fetched = []
  const cache = createImageCache(async key => { fetched.push(key); return new Blob([key]) })
  const first = await cache.load('release-a/image')
  assert.equal(await cache.load('release-a/image'), first)
  await cache.load('release-b/image')
  assert.deepEqual(fetched, ['release-a/image', 'release-b/image'])
})

test('logout clears cached bytes and rejects an old response even if its transport ignores abort', async () => {
  let finish, oldSignal
  const cache = createImageCache(async (key, signal) => {
    if (key === 'pending') {
      oldSignal = signal
      return new Promise(resolve => { finish = resolve })
    }
    return new Blob(['private bytes'])
  })
  const original = await cache.load('ready')
  const pending = cache.load('pending')
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  cache.clear()
  assert.equal(oldSignal.aborted, true)
  finish(new Blob(['old session']))
  await rejected
  assert.notEqual(await cache.load('ready'), original)
})

test('scroll or navigation cancellation cannot add an incomplete request to the cache', async () => {
  let calls = 0, finish
  const cache = createImageCache(async () => {
    calls++
    if (calls === 1) return new Promise(resolve => { finish = resolve })
    return new Blob(['retry'])
  })
  const controller = new AbortController()
  const pending = cache.load('image', controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort(); finish(new Blob(['cancelled']))
  await rejected
  assert.equal(await (await cache.load('image')).text(), 'retry')
  assert.equal(calls, 2)
})

test('bounded cache evicts least recently read images and does not retain oversized images', async () => {
  const fetched = []
  const cache = createImageCache(async key => {
    fetched.push(key)
    return new Blob([key === 'large' ? '123456' : '12'])
  }, { maxBytes: 4 })
  await cache.load('a'); await cache.load('b'); await cache.load('a')
  await cache.load('c'); await cache.load('a'); await cache.load('b')
  await cache.load('large'); await cache.load('large')
  assert.deepEqual(fetched, ['a', 'b', 'c', 'b', 'large', 'large'])
})

test('failed images can be retried and explicitly discarded after a decode failure', async () => {
  let calls = 0
  const cache = createImageCache(async () => {
    if (++calls === 1) throw Error('Network unavailable')
    return new Blob(['image'])
  })
  await assert.rejects(cache.load('image'), /Network unavailable/)
  await cache.load('image')
  cache.remove('image')
  await cache.load('image')
  assert.equal(calls, 3)
})
