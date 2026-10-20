import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportContent } from '../scripts/export-content.mjs'

test('private export includes page content and referenced media, but no executable bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reader-content-'))
  try {
    const dist = join(root, 'dist'), out = join(root, 'out')
    await mkdir(join(dist, 'notes'), { recursive: true })
    await mkdir(join(dist, 'assets'))
    await writeFile(join(dist, 'notes/example.html'), `<html><body><nav class="VPSidebar"><a href="/course/notes/example">Lec 01 · Introduction</a><a href="/course/notes/other">Other</a></nav><div class="vp-doc"><div>
      <h1>Example lesson</h1><p>Private sample paragraph.</p>
      <img src="/course/assets/sample.png" width="10" height="10">
      <a href="/course/notes/other.html#part">Other</a>
      <figure class="study-diagram" data-diagram-id="diagram-one"><p>diagram fallback</p></figure>
      </div></div><script src="/course/assets/notes_example.js"></script></body></html>`)
    await writeFile(join(dist, 'assets/sample.png'), 'sample bytes')
    await writeFile(join(dist, 'assets/notes_example.js'), 'private module text')
    const manifest = await exportContent({ dist, out, diagrams: { 'diagram-one': { title: 'Diagram', source: 'graph LR; A-->B', height: 100, description: 'Example' } } })
    assert.equal(manifest.pages.length, 1)
    assert.equal(manifest.pages[0].title, 'Lec 01 · Introduction')
    const page = JSON.parse(await readFile(join(out, 'releases', manifest.release, manifest.pages[0].file), 'utf8'))
    assert.match(page.html, /Private sample paragraph/)
    assert.equal(page.title, 'Lec 01 · Introduction')
    assert.match(page.html, /<h1>Example lesson<\/h1>/)
    assert.match(page.html, /data-private-src="assets\/sample.png"/)
    assert.doesNotMatch(page.html, /\ssrc=|<script|Private nav/)
    assert.match(page.html, /href="\/notes\/other#part"/)
    assert.equal(page.diagrams['diagram-one'].title, 'Diagram')
    await assert.rejects(readFile(join(out, 'releases', manifest.release, 'assets/notes_example.js')))
    assert.equal(await readFile(join(out, 'releases', manifest.release, 'assets/sample.png'), 'utf8'), 'sample bytes')
  } finally { await rm(root, { recursive: true, force: true }) }
})
