import { readFile, readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) throw Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
const root = '.private-content'
const manifest = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
async function walk(dir) {
  const files = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const name = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await walk(name))
    else files.push(name)
  }
  return files
}
async function upload(file) {
  const bytes = await readFile(join(root, file))
  const type = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream'
  const { error } = await client.storage.from('site-content').upload(file, bytes, { contentType: type, cacheControl: '0', upsert: true })
  if (error) throw Error(`Upload failed: ${file}: ${error.message}`)
}
const files = await walk(`releases/${manifest.release}`)
for (let i = 0; i < files.length; i += 6) await Promise.all(files.slice(i, i + 6).map(upload))
for (let i = 0; i < files.length; i += 6) {
  await Promise.all(files.slice(i, i + 6).map(async file => {
    const { data, error } = await client.storage.from('site-content').download(file)
    if (error || !Buffer.from(await data.arrayBuffer()).equals(await readFile(join(root, file)))) throw Error(`Read-back failed: ${file}`)
  }))
}
await upload('current.json')
const current = await fetch(`${url}/storage/v1/object/authenticated/site-content/current.json?verify=${Date.now()}`, {
  headers: { Authorization: `Bearer ${key}`, apikey: key }, cache: 'no-store',
})
if (!current.ok || (await current.json()).release !== manifest.release) throw Error('Manifest verification failed')
console.log(`Uploaded and byte-verified ${files.length} private objects; release ${manifest.release} is current`)
