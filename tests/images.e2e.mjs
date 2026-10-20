import { chromium } from 'playwright'
import assert from 'node:assert/strict'

// Deterministic loading tests. Live authentication/storage isolation is covered by reader.e2e.mjs.
const base = process.env.READER_URL || 'http://127.0.0.1:4179/os3150-site/'
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const counts = new Map(), errors = []
let releaseImages, blockImages = true, failImage = 'image-3.svg', account = 0
const waiting = new Promise(resolve => { releaseImages = resolve })
const manifest = { version: 1, release: '1234567890abcdef', pages: [
  { path: '/notes/example', title: 'Lec 01 · Example', kind: 'notes', file: 'pages/example.json' },
] }
const lesson = { path: '/notes/example', title: 'Example', text: 'Test content', diagrams: {},
  html: '<h1>Example</h1><p>Readable before images finish.</p>' + Array.from({ length: 6 }, (_, i) =>
    `<h2 id="section-${i}">Section ${i}</h2><p><img alt="Figure ${i}" width="1000" height="700" data-private-src="assets/image-${i}.svg"></p>`).join('') }
page.on('pageerror', e => errors.push(e.message))
await page.route('https://*.supabase.co/**', async route => {
  const path = new URL(route.request().url()).pathname
  const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  if (path === '/auth/v1/token') {
    const id = `00000000-0000-4000-8000-00000000000${++account}`
    const user = { id, aud: 'authenticated', role: 'authenticated', email: 'reader@example.com', app_metadata: {}, user_metadata: {} }
    const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, exp: Math.floor(Date.now()/1000)+3600, role: 'authenticated' })).toString('base64url'), 'test'].join('.')
    return json({ access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600, user })
  }
  if (path === '/auth/v1/logout') return route.fulfill({ status: 204 })
  if (path.includes('/rest/v1/')) return json([])
  if (path.endsWith('/current.json')) return json(manifest)
  if (path.endsWith('/pages/example.json')) return json(lesson)
  if (path.includes('/assets/')) {
    const name = path.split('/').pop()
    counts.set(name, (counts.get(name) || 0) + 1)
    if (blockImages) await waiting
    if (name === failImage) { failImage = ''; return route.fulfill({ status: 503, body: 'Temporarily unavailable' }).catch(() => {}) }
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="#aaccc0"/></svg>' }).catch(() => {})
  }
  throw Error('Unexpected fixture request: ' + path)
})
async function login() {
  await page.locator('#reader-email').fill('reader@example.com')
  await page.locator('#reader-password').fill('test-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.locator('.reader-main').waitFor()
}
async function ready(index) {
  await page.waitForFunction(index => document.querySelectorAll('.vp-doc img')[index]?.dataset.imageState === 'ready', index)
}
try {
  await page.goto(base); await login(); await page.locator('.lec-card').click()
  await page.locator('.vp-doc h1').waitFor()
  await page.waitForFunction(() => document.querySelector('img[data-image-state="loading"]'))
  assert.equal(await page.locator('.reader-loading').count(), 0)
  assert.ok(counts.size <= 2)
  assert.equal(counts.has('image-5.svg'), false)
  const before = await page.locator('.vp-doc img').first().boundingBox()
  blockImages = false; releaseImages(); await ready(0)
  const after = await page.locator('.vp-doc img').first().boundingBox()
  assert.ok(Math.abs(before.height - after.height) < 1, 'image space stays stable')
  const firstDownloads = counts.get('image-0.svg')
  await page.locator('.reader-brand').click(); await page.locator('.lec-card').click(); await ready(0)
  assert.equal(counts.get('image-0.svg'), firstDownloads, 'chapter revisit uses session memory')
  assert.equal(counts.has('image-5.svg'), false)
  const third = page.locator('.vp-doc img').nth(3)
  await third.scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: 'Retry image: Figure 3', exact: true }).waitFor()
  assert.equal(await page.locator('.reader-error').count(), 0)
  await page.getByRole('button', { name: 'Retry image: Figure 3', exact: true }).click(); await ready(3)
  assert.equal(counts.get('image-3.svg'), 2)
  const privateUrl = await third.getAttribute('src')
  await page.getByRole('button', { name: 'Account', exact: true }).click()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
  assert.equal(await page.locator('.vp-doc img').count(), 0)
  assert.equal(await page.evaluate(async url => { try { await fetch(url); return true } catch { return false } }, privateUrl), false)
  await login(); await ready(0)
  assert.ok(counts.get('image-0.svg') > firstDownloads, 'another account cannot reuse the old image cache')
  assert.deepEqual(errors, [])
  console.log('PASS: non-blocking text, nearby-only loading, stable image space, cached revisits, per-image retry, revoked blob URLs and account cache isolation')
} finally { await browser.close() }
