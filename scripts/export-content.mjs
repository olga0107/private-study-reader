import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import sharp from 'sharp'

export async function exportContent({ dist = '.vitepress/dist', out = '.private-content', diagrams = {} } = {}) {
  const pages = [], media = new Map(), converted = new Map(), digest = createHash('sha256')
  async function prepareImage(file) {
    if (converted.has(file)) return converted.get(file)
    let name = file, bytes = await readFile(join(dist, file))
    if (/\.png$/i.test(file)) {
      const webp = await sharp(bytes).webp({ lossless: true, effort: 4 }).toBuffer()
      if (webp.length < bytes.length) {
        const [original, decoded] = await Promise.all([
          sharp(bytes).ensureAlpha().raw().toBuffer(),
          sharp(webp).ensureAlpha().raw().toBuffer(),
        ])
        // Retain the PNG if color conversion or transparency changes any pixel.
        if (original.equals(decoded)) { bytes = webp; name = file.replace(/\.png$/i, '.webp') }
      }
    }
    media.set(name, bytes); converted.set(file, name)
    return name
  }
  for (const group of ['notes', 'foundations']) {
    let files
    try { files = await readdir(join(dist, group)) } catch { continue }
    for (const name of files.filter(f => /^[a-z0-9-]+\.html$/.test(f)).sort()) {
      const $ = load(await readFile(join(dist, group, name), 'utf8'))
      const doc = $('.vp-doc').first()
      if (!doc.length) throw Error(`Missing document: ${group}/${name}`)
      doc.find('script, iframe, object, embed').remove()
      const pageDiagrams = {}
      doc.find('[data-diagram-id]').each((_, el) => {
        const id = $(el).attr('data-diagram-id')
        if (!diagrams[id]) throw Error(`Missing diagram: ${id}`)
        pageDiagrams[id] = diagrams[id]
      })
      for (const el of doc.find('img').toArray()) {
        const src = $(el).attr('src') || ''
        const match = src.match(/(?:^|\/)(assets\/[a-zA-Z0-9._-]+)$/)
        if (!match) throw Error(`Unsupported image URL in ${name}`)
        const name = await prepareImage(match[1])
        $(el).removeAttr('src').removeAttr('srcset').attr('data-private-src', name)
      }
      doc.find('a[href]').each((_, el) => {
        const href = $(el).attr('href')
        const match = href.match(/\/((?:notes|foundations)\/[a-z0-9-]+)(?:\.html)?(#[^?]*)?$/)
        if (match) $(el).attr('href', '/' + match[1] + (match[2] || ''))
      })
      const path = `/${group}/${name.replace(/\.html$/, '')}`
      const navigation = $('.VPSidebar a').toArray().find(el =>
        $(el).attr('href')?.replace(/\.html$/, '').replace(/\/$/, '').endsWith(path))
      const title = (navigation ? $(navigation).text() : doc.find('h1').first().text()).replace(/\u200b/g, '').trim() || name
      const file = `pages/${group}-${name.replace(/\.html$/, '.json')}`
      const body = JSON.stringify({ path, title, html: doc.html(), text: doc.text().replace(/\s+/g, ' ').trim(), diagrams: pageDiagrams })
      pages.push({ path, title, kind: group, file, body })
      digest.update(file).update(body)
    }
  }
  if (!pages.length) throw Error('No private pages were exported')
  for (const file of [...media.keys()].sort()) digest.update(file).update(media.get(file))
  const release = digest.digest('hex').slice(0, 16)
  await rm(out, { recursive: true, force: true })
  const base = join(out, 'releases', release)
  for (const page of pages) {
    await mkdir(dirname(join(base, page.file)), { recursive: true })
    await writeFile(join(base, page.file), page.body)
  }
  for (const [file, bytes] of media) {
    await mkdir(dirname(join(base, file)), { recursive: true })
    await writeFile(join(base, file), bytes)
  }
  const manifest = { version: 1, release, pages: pages.map(({ body, ...page }) => page) }
  await writeFile(join(out, 'current.json'), JSON.stringify(manifest))
  return manifest
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const diagrams = JSON.parse(await readFile('.vitepress/theme/diagrams.json', 'utf8'))
  const manifest = await exportContent({ diagrams })
  console.log(`Exported ${manifest.pages.length} private pages (${manifest.release})`)
}
