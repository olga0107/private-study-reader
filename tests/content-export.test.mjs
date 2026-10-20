import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { exportContent } from '../scripts/export-content.mjs'

test('private export includes page content and referenced media, but no executable bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reader-content-'))
  try {
    const dist = join(root, 'dist'), out = join(root, 'out')
    await mkdir(join(dist, 'notes'), { recursive: true })
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'notes/example.html'), `<html><body><nav class="VPSidebar"><a href="/course/notes/example">Lec 01 · Introduction</a><a href="/course/notes/other">Other</a></nav><div class="vp-doc"><div>
      <h1>Example lesson</h1><p>Private sample paragraph.</p>
      <img src="/course/assets/sample.svg" width="10" height="10">
      <a href="/course/notes/other.html#part">Other</a>
      <figure class="study-diagram" data-diagram-id="diagram-one"><p>diagram fallback</p></figure>
      </div></div><script src="/course/assets/notes_example.js"></script></body></html>`)
    await writeFile(join(dist, 'assets/sample.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
    await writeFile(join(dist, 'assets/notes_example.js'), 'private module text')
    const manifest = await exportContent({ dist, out, diagrams: { 'diagram-one': { title: 'Diagram', source: 'graph LR; A-->B', height: 100, description: 'Example' } } })
    assert.equal(manifest.pages.length, 1)
    assert.equal(manifest.pages[0].title, 'Lec 01 · Introduction')
    const page = JSON.parse(await readFile(join(out, 'releases', manifest.release, manifest.pages[0].file), 'utf8'))
    assert.match(page.html, /Private sample paragraph/)
    assert.equal(page.title, 'Lec 01 · Introduction')
    assert.match(page.html, /<h1>Example lesson<\/h1>/)
    assert.match(page.html, /data-private-src="assets\/sample.svg"/)
    assert.doesNotMatch(page.html, /\ssrc=|<script|Private nav/)
    assert.match(page.html, /href="\/notes\/other#part"/)
    assert.equal(page.diagrams['diagram-one'].title, 'Diagram')
    await assert.rejects(readFile(join(out, 'releases', manifest.release, 'assets/notes_example.js')))
    assert.equal(await readFile(join(out, 'releases', manifest.release, 'assets/sample.svg'), 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('PNG exports become smaller WebP with identical pixels, unchanged sources and a new release for changed pixels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reader-images-'))
  try {
    const dist = join(root, 'dist'), out = join(root, 'out')
    await mkdir(join(dist, 'notes'), { recursive: true }); await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'notes/example.html'), '<div class="vp-doc"><h1>Example</h1><img src="/assets/example.png" width="256" height="256"></div>')
    const original = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#2a7466' } }).png().toBuffer()
    await writeFile(join(dist, 'assets/example.png'), original)
    const manifest = await exportContent({ dist, out })
    const compressed = await readFile(join(out, 'releases', manifest.release, 'assets/example.webp'))
    assert.ok(compressed.length < original.length)
    assert.deepEqual(await sharp(compressed).ensureAlpha().raw().toBuffer(), await sharp(original).ensureAlpha().raw().toBuffer())
    assert.deepEqual(await readFile(join(dist, 'assets/example.png')), original)
    const body = JSON.parse(await readFile(join(out, 'releases', manifest.release, manifest.pages[0].file), 'utf8'))
    assert.match(body.html, /width="256" height="256" data-private-src="assets\/example.webp"/)
    const updated = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#112244' } }).png().toBuffer()
    await writeFile(join(dist, 'assets/example.png'), updated)
    assert.notEqual((await exportContent({ dist, out })).release, manifest.release)
  } finally { await rm(root, { recursive: true, force: true }) }
})
