import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'

const base = process.env.READER_URL || 'http://127.0.0.1:4178/os3150-site/'
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw Error('Provide SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the opt-in browser test')
const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const users = [], errors = [], evidence = []
const out = '.inbox/reader-review'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, channel: 'chrome' })
const contexts = []
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  contexts.push(ctx)
  const page = await ctx.newPage()
  page.on('pageerror', error => errors.push(error.message))
  return { ctx, page }
}
async function login(page, user) {
  await page.goto(base)
  await submitLogin(page, user)
}
async function submitLogin(page, user) {
  await page.locator('#reader-email').fill(user.email)
  await page.locator('#reader-password').fill(user.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('.reader-main').waitFor({ timeout: 30000 })
}
async function chapter(page, path = '/notes/lec06-sockets-pipes') {
  await page.goto(base + '#' + path)
  await page.locator('.annotation-entry').waitFor({ timeout: 30000 })
  await page.waitForFunction(() => !document.querySelector('.reader-loading'), null, { timeout: 45000 })
}
async function sync(page) {
  const pulled = page.waitForResponse(response => response.url().includes('/rest/v1/annotations?') && response.request().method() === 'GET')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const rows = await (await pulled).json()
  await page.waitForFunction(rows => {
    const raw = Object.entries(localStorage).find(([key]) => key.startsWith('os-cloud-v1:'))?.[1]
    const entries = raw ? Object.values(JSON.parse(raw).entries) : []
    return rows.every(row => entries.some(entry => entry.page_path === row.page_path && entry.kind === row.kind &&
      (entry.revision >= row.revision || entry.conflict?.revision >= row.revision)))
  }, rows)
}
async function mark(page, index, note) {
  await page.evaluate(index => {
    const nodes = []
    for (const p of document.querySelectorAll('.vp-doc p')) {
      if (p.closest('figure, table, .study-diagram, .custom-block')) continue
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) if (walker.currentNode.textContent.trim().length > 16 && !walker.currentNode.parentElement.closest('code,a')) nodes.push(walker.currentNode)
    }
    const n = nodes[index]
    if (!n) throw Error('No selectable fixture paragraph')
    n.parentElement.scrollIntoView({ block: 'center' })
    const range = document.createRange()
    range.setStart(n, 0); range.setEnd(n, Math.min(n.textContent.length, 24))
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, index)
  await page.locator('.annotation-float button').nth(1).click()
  await page.locator('#annotation-note').fill(note)
  await page.getByRole('button', { name: '保存标记', exact: true }).click()
}
async function rows(user, kind) {
  const { data, error } = await admin.from('annotations').select('*').eq('user_id', user.id).eq('kind', kind)
  assert.ifError(error); return data
}
async function until(fn, label) {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw Error('Timed out: ' + label)
}
try {
  for (const suffix of ['a', 'b']) {
    const email = `reader-e2e-${randomUUID()}-${suffix}@example.com`, password = randomUUID() + 'aA1!'
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    assert.ifError(error); users.push({ id: data.user.id, email, password })
  }
  const a = await context(), b = await context(), other = await context()
  await a.page.goto(base + '#/notes/lec06-sockets-pipes')
  await a.page.locator('#reader-email').waitFor()
  assert.equal(await a.page.locator('.vp-doc').count(), 0)
  await a.page.screenshot({ path: out + '/login.png' })
  await login(a.page, users[0]); await chapter(a.page)
  assert.equal(await a.page.locator('.vp-doc h1').count(), 1)
  assert.equal(await a.page.locator('.sync-panel').count(), 0)
  assert.equal(await a.page.locator('.vp-doc img').count(), 18)
  await a.page.locator('.vp-doc img').evaluateAll(async imgs => {
    for (const img of imgs) img.loading = 'eager'
    await Promise.all(imgs.map(img => img.decode()))
  })
  assert.equal(await a.page.locator('.vp-doc img').evaluateAll(imgs => imgs.every(img => img.complete && img.naturalWidth > 0 && img.src.startsWith('blob:'))), true)
  const navigationTitles = await a.page.locator('.reader-chapter-link').evaluateAll(links => links.map(link => link.getAttribute('aria-label')))
  assert.ok(navigationTitles.includes('Lec 01 · Introduction'))
  assert.equal(navigationTitles.some(title => /[\u3400-\u9fff]/.test(title) && title !== '首页'), false)
  evidence.push('Anonymous login gate; authenticated chapter with all 18 private images; original English navigation and no persistent sync panel')
  await mark(a.page, 0, 'browser-first-note')
  await until(async () => (await rows(users[0], 'marks'))[0]?.payload.length === 1, 'first cloud mark')
  await login(b.page, users[0]); await chapter(b.page)
  assert.equal((await b.page.locator('.annotation-count').textContent()).trim(), '1')
  await login(other.page, users[1]); await chapter(other.page)
  assert.equal((await other.page.locator('.annotation-count').textContent()).trim(), '0')
  evidence.push('Same account sees annotation on fresh browser; different account sees zero')
  // A draft stays open while the other browser changes the same note.
  await a.page.locator('.annotation-entry').click()
  await a.page.getByRole('button', { name: '编辑批注', exact: true }).first().click()
  await a.page.locator('#annotation-note').fill('stale-editor-local-note')
  await b.page.locator('.annotation-entry').click()
  await b.page.getByRole('button', { name: '编辑批注', exact: true }).first().click()
  await b.page.locator('#annotation-note').fill('newer-remote-note')
  await b.page.getByRole('button', { name: '保存标记', exact: true }).click()
  await b.page.getByRole('button', { name: '关闭标记列表', exact: true }).click()
  await until(async () => (await rows(users[0], 'marks'))[0]?.payload[0]?.note === 'newer-remote-note', 'remote editor save')
  await a.page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await a.page.waitForFunction(() => {
    const raw = Object.entries(localStorage).find(([key]) => key.startsWith('os-cloud-v1:'))?.[1]
    return raw && Object.values(JSON.parse(raw).entries).some(entry => entry.kind === 'marks' && entry.payload.some(mark => mark.note === 'newer-remote-note'))
  })
  await a.page.getByRole('button', { name: '保存标记', exact: true }).click()
  await a.page.getByRole('button', { name: '关闭标记列表', exact: true }).click()
  await a.page.locator('.sync-conflict').waitFor()
  const staleDownload = a.page.waitForEvent('download')
  await a.page.getByRole('button', { name: '导出两份备份', exact: true }).click()
  await (await staleDownload).saveAs(out + '/stale-editor-conflict.json')
  const staleConflict = JSON.parse(await readFile(out + '/stale-editor-conflict.json', 'utf8'))
  assert.equal(staleConflict.local[0].note, 'stale-editor-local-note')
  assert.equal(staleConflict.cloud[0].note, 'newer-remote-note')
  await a.page.getByRole('button', { name: '使用云端版本', exact: true }).click()
  await until(async () => await a.page.locator('.sync-conflict').count() === 0, 'stale editor conflict resolved')
  evidence.push('An open stale editor preserves both local draft and refreshed remote note as an explicit conflict')
  await a.ctx.setOffline(true); await b.ctx.setOffline(true)
  await mark(a.page, 1, 'device-a-offline-note')
  await mark(b.page, 2, 'device-b-offline-note')
  await a.ctx.setOffline(false)
  await until(async () => (await rows(users[0], 'marks'))[0]?.payload.length === 2, 'offline queue flush')
  await b.ctx.setOffline(false); await sync(b.page)
  await b.page.locator('.sync-conflict').waitFor()
  const download = b.page.waitForEvent('download')
  await b.page.getByRole('button', { name: '导出两份备份', exact: true }).click()
  await (await download).saveAs(out + '/conflict.json')
  const conflict = JSON.parse(await readFile(out + '/conflict.json', 'utf8'))
  assert.ok(conflict.local.some(mark => mark.note === 'device-b-offline-note'))
  assert.ok(conflict.cloud.some(mark => mark.note === 'device-a-offline-note'))
  await b.page.getByRole('button', { name: '使用云端版本', exact: true }).click()
  await until(async () => await b.page.locator('.sync-conflict').count() === 0, 'resolve conflict')
  assert.equal((await b.page.locator('.annotation-count').textContent()).trim(), '2')
  evidence.push('Two offline edits produce a visible conflict; both versions exportable; explicit cloud selection')
  // Draw, undo, redo with actual pointer input; cloud data must follow the controls.
  await a.page.evaluate(() => window.scrollTo(0, 0))
  await a.page.getByRole('button', { name: '手写批注', exact: true }).click()
  const box = await a.page.locator('.vp-doc h1').boundingBox()
  await a.page.mouse.move(box.x + 20, box.y + 45)
  await a.page.mouse.down(); await a.page.mouse.move(box.x + 130, box.y + 75, { steps: 14 }); await a.page.mouse.up()
  await until(async () => (await rows(users[0], 'ink'))[0]?.payload.strokes.length === 1, 'ink upload')
  await a.page.locator('.ink-panel button[title="撤销"]').click()
  await until(async () => (await rows(users[0], 'ink'))[0]?.payload.strokes.length === 0, 'ink undo')
  await a.page.locator('.ink-panel button[title="重做"]').click()
  await until(async () => (await rows(users[0], 'ink'))[0]?.payload.strokes.length === 1, 'ink redo')
  await a.page.locator('.ink-panel button[title="退出批注"]').click()
  await sync(b.page)
  const bInk = await b.page.evaluate(() => JSON.parse(Object.entries(localStorage).find(([k]) => k.startsWith('os-cloud-v1:'))[1]))
  assert.equal(Object.values(bInk.entries).find(e => e.kind === 'ink').payload.strokes.length, 1)
  evidence.push('Pointer-drawn ink, undo, redo and second-browser synchronization')
  // Verify diagrams, full-text search and small-screen layout.
  await chapter(a.page, '/notes/lec07-concurrency')
  await a.page.locator('.study-diagram').first().scrollIntoViewIfNeeded()
  await a.page.locator('.study-diagram .diagram-scroll svg').first().waitFor({ timeout: 30000 })
  await a.page.locator('.study-diagram').first().getByRole('button', { name: /放大图示/ }).click()
  await a.page.locator('dialog.diagram-dialog[open]').waitFor()
  await a.page.getByRole('button', { name: '关闭图示', exact: true }).click()
  await a.page.screenshot({ path: out + '/desktop.png', fullPage: false })
  await a.page.locator('#reader-search').fill('socket')
  await a.page.locator('.reader-search button').click()
  const socketResult = a.page.locator('.reader-search-results a[href="#/notes/lec06-sockets-pipes"]')
  await socketResult.waitFor({ timeout: 30000 })
  await socketResult.click()
  await a.page.waitForFunction(() => !document.querySelector('.reader-loading') &&
    document.querySelector('.vp-doc h1')?.textContent.includes('Sockets'), null, { timeout: 45000 })
  await a.page.setViewportSize({ width: 390, height: 844 })
  await a.page.evaluate(() => window.scrollTo(0, 0))
  assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
  const chapterUrl = a.page.url()
  await a.page.getByRole('button', { name: /本讲大纲/ }).click()
  await a.page.locator('#chapter-outline a').nth(1).click()
  assert.equal(a.page.url(), chapterUrl)
  assert.equal(await a.page.locator('.vp-doc h1').count(), 1)
  assert.equal(await a.page.locator('.reader-error').count(), 0)
  await a.page.evaluate(() => window.scrollTo(0, 0))
  await a.page.getByRole('button', { name: '切换深色', exact: true }).click()
  await a.page.screenshot({ path: out + '/mobile-dark.png' })
  evidence.push('Private diagrams with zoom, authenticated full-text search, mobile width and dark theme')
  // Logout interrupts a delayed search; re-login in the same app must reset busy state.
  await a.page.setViewportSize({ width: 1440, height: 1000 })
  let delayedSearch = false, releaseSearch
  const waitSearch = new Promise(resolve => { releaseSearch = resolve })
  const searchPattern = '**/storage/v1/object/authenticated/site-content/releases/*/pages/*'
  await a.page.route(searchPattern, async route => {
    delayedSearch = true
    await waitSearch
    await route.abort().catch(() => {})
  })
  await a.page.locator('#reader-search').fill('memory')
  await a.page.locator('.reader-search button').click()
  await until(async () => delayedSearch, 'delayed search request')
  let logoutStarted = false, releaseLogout
  const waitLogout = new Promise(resolve => { releaseLogout = resolve })
  const logoutPattern = '**/auth/v1/logout**'
  await a.page.route(logoutPattern, async route => {
    logoutStarted = true
    await waitLogout
    await route.continue().catch(() => {})
  })
  await a.page.getByRole('button', { name: '账号设置', exact: true }).click()
  await a.page.getByRole('button', { name: '退出登录', exact: true }).click()
  await a.page.locator('#reader-email').waitFor()
  await until(async () => logoutStarted, 'delayed logout request')
  assert.equal(await a.page.locator('.reader-login button[type="submit"], .reader-login .reader-primary').isEnabled(), false)
  releaseLogout()
  await a.page.getByRole('button', { name: '登录', exact: true }).waitFor()
  await a.page.unroute(logoutPattern)
  releaseSearch()
  await a.page.unroute(searchPattern)
  assert.equal(await a.page.locator('.vp-doc').count(), 0)
  await submitLogin(a.page, users[1])
  assert.equal(await a.page.locator('.reader-search button').isEnabled(), true)
  await chapter(a.page)
  assert.equal((await a.page.locator('.annotation-count').textContent()).trim(), '0')
  evidence.push('Logout cancels search and removes content; login waits for delayed sign-out; account switch resets search and isolates marks')
  // Two same-origin tabs edit different chapters while offline.
  const secondTab = await a.ctx.newPage()
  secondTab.on('pageerror', error => errors.push(error.message))
  let releaseAnnotations
  const waitAnnotations = new Promise(resolve => { releaseAnnotations = resolve })
  const annotationsPattern = '**/rest/v1/annotations**'
  await secondTab.route(annotationsPattern, async route => {
    await waitAnnotations
    await route.continue().catch(() => {})
  })
  await chapter(secondTab, '/notes/lec07-concurrency')
  releaseAnnotations()
  await secondTab.unroute(annotationsPattern)
  evidence.push('Reading remains available while initial annotation retrieval is delayed')
  await a.ctx.setOffline(true)
  await Promise.all([mark(a.page, 0, 'same-browser-tab-one'), mark(secondTab, 0, 'same-browser-tab-two')])
  await a.ctx.setOffline(false)
  await until(async () => (await rows(users[1], 'marks')).length === 2, 'both tabs retained')
  const tabNotes = (await rows(users[1], 'marks')).flatMap(row => row.payload.map(mark => mark.note))
  assert.deepEqual(tabNotes.sort(), ['same-browser-tab-one', 'same-browser-tab-two'])
  evidence.push('Concurrent same-account tabs retain and upload both chapter edits')
  let pendingPage = false, releasePage
  const waitPage = new Promise(resolve => { releasePage = resolve })
  await other.page.route(searchPattern, async route => {
    pendingPage = true
    await waitPage
    await route.abort().catch(() => {})
  })
  await other.page.evaluate(() => { location.hash = '/notes/lec07-concurrency' })
  await until(async () => pendingPage, 'pending chapter navigation')
  await other.page.evaluate(() => { location.hash = '/notes/missing-page' })
  await other.page.locator('.reader-error').waitFor()
  assert.equal(await other.page.locator('.reader-loading').count(), 0)
  releasePage()
  await other.page.unroute(searchPattern)
  evidence.push('Unknown routes cancel a pending chapter load without leaving a stuck loading state')
  assert.deepEqual(errors, [])
  await writeFile(out + '/results.json', JSON.stringify({ evidence, errors }, null, 2))
  console.log(evidence.join('\n'))
} catch (error) {
  for (const [i, ctx] of contexts.entries()) {
    const p = ctx.pages()[0]
    if (p) {
      await p.screenshot({ path: `${out}/failure-${i}.png` }).catch(() => {})
      await writeFile(`${out}/failure-${i}.txt`, await p.locator('body').innerText()).catch(() => {})
    }
  }
  throw error
} finally {
  await browser.close()
  for (const user of users) await admin.auth.admin.deleteUser(user.id)
}
