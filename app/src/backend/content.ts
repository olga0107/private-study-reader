import { supabase } from './client'
export type PageRef = { path: string; title: string; kind: string; file: string }
export type Manifest = { version: number; release: string; pages: PageRef[] }
export type Page = {
  path: string; title: string; html: string; text: string;
  diagrams: Record<string, { title: string; source: string; description: string; height: number }>;
}
export async function privateObject(key: string, signal?: AbortSignal) {
  if (!supabase) throw Error('站点尚未配置后端连接。')
  const { data: { session }, error } = await supabase.auth.getSession()
  if (error || !session) throw Error('登录已失效，请重新登录。')
  const version = key === 'current.json' ? `?v=${Date.now()}` : ''
  const response = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/authenticated/site-content/${key}${version}`,
    { headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store', signal },
  )
  if (!response.ok) throw Error(response.status === 401 || response.status === 403
    ? '无权读取内容，请重新登录。' : '内容暂时无法加载，请重试。')
  return response
}
export async function loadManifest(signal?: AbortSignal): Promise<Manifest> {
  const result = await (await privateObject('current.json', signal)).json()
  if (result.version !== 1 || !/^[a-f0-9]{16}$/.test(result.release) ||
      !Array.isArray(result.pages) || result.pages.some((p: PageRef) =>
        !/^\/(notes|foundations)\/[a-z0-9-]+$/.test(p.path) ||
        !/^pages\/[a-z0-9-]+\.json$/.test(p.file))) throw Error('内容目录格式不受支持。')
  return result
}
export async function loadPage(manifest: Manifest, page: PageRef, signal?: AbortSignal): Promise<Page> {
  return (await privateObject(`releases/${manifest.release}/${page.file}`, signal)).json()
}
