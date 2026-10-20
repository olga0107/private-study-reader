<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, createApp, type App as VueApp } from 'vue'
import DOMPurify from 'dompurify'
import { supabase } from './backend/client'
import { loadManifest, loadPage, privateObject, type Manifest, type Page, type PageRef } from './backend/content'
import { initSync, stopSync } from './backend/sync'
import { route, isDark, contentUpdated } from './reader-context'
import ReadingTools from '../../.vitepress/theme/components/ReadingTools.vue'
import StudyDiagram from '../../.vitepress/theme/components/StudyDiagram.vue'
import SyncPanel from './components/SyncPanel.vue'

const email = ref(''), password = ref(''), authError = ref(''), busy = ref(false), signingOut = ref(false)
const userId = ref(''), account = ref(''), ready = ref(false), starting = ref(true)
const manifest = ref<Manifest | null>(null), page = ref<Page | null>(null), error = ref(''), loading = ref(false)
const menu = ref(false), query = ref(''), searchBusy = ref(false), searchError = ref('')
const results = ref<{ path: string; title: string; snippet: string }[]>([])
const article = ref<HTMLElement>(), headings = ref<{id: string; title: string}[]>([])
let generation = 0, navigation = 0, searchGeneration = 0, authGeneration = 0, request: AbortController | null = null
let searchRequest: AbortController | null = null
let urls: string[] = [], diagrams: VueApp[] = [], unsubscribe: (() => void) | undefined
const pages = computed(() => manifest.value?.pages || [])
const lectures = computed(() => pages.value.filter(p => p.kind === 'notes'))
const foundations = computed(() => pages.value.filter(p => p.kind === 'foundations'))
const lectureIndex = computed(() => lectures.value.findIndex(p => p.path === route.path))
const prev = computed(() => lectureIndex.value > 0 ? lectures.value[lectureIndex.value - 1] : null)
const next = computed(() => lectureIndex.value >= 0 ? lectures.value[lectureIndex.value + 1] : null)
const safeHtml = computed(() => DOMPurify.sanitize(page.value?.html || '', {
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'style'],
  FORBID_ATTR: ['src', 'srcset'],
}))
function cleanPage() {
  request?.abort()
  diagrams.forEach(app => app.unmount()); diagrams = []
  urls.forEach(url => URL.revokeObjectURL(url)); urls = []
  page.value = null; headings.value = []
  loading.value = false
}
function clearPrivateState() {
  generation++; navigation++; searchGeneration++
  searchRequest?.abort(); searchBusy.value = false
  stopSync(); cleanPage()
  ready.value = false; manifest.value = null; query.value = ''; results.value = []
  account.value = ''; error.value = ''; searchError.value = ''
}
async function setSession(session: any) {
  starting.value = false
  const id = session?.user?.id || ''
  if (id === userId.value && ready.value) return
  clearPrivateState()
  userId.value = id
  if (!id) return
  account.value = session.user.email
  const epoch = generation
  try {
    void initSync(id)
    const data = await loadManifest()
    if (epoch !== generation) return
    manifest.value = data; ready.value = true
    await openRoute()
  } catch (e) {
    if (epoch === generation) error.value = (e as Error).message
  }
}
async function login() {
  if (!supabase || busy.value || signingOut.value) return
  busy.value = true; authError.value = ''
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: email.value.trim(), password: password.value })
    if (error) authError.value = '登录失败，请检查账号密码或联系账号管理员。'
  } catch { authError.value = '暂时无法连接，请检查网络后重试。' }
  finally { password.value = ''; busy.value = false }
}
async function logout() {
  signingOut.value = true
  clearPrivateState(); userId.value = ''
  try { await supabase?.auth.signOut({ scope: 'local' }) }
  finally { signingOut.value = false }
}
async function retry() {
  const { data } = await supabase!.auth.getSession()
  await setSession(data.session)
}
function href(path: string) { return '#' + path }
function go(path: string) {
  menu.value = false; query.value = ''; results.value = []
  if (location.hash === '#' + path) openRoute()
  else location.hash = path
}
async function openRoute() {
  if (!ready.value || !manifest.value) return
  const raw = location.hash.slice(1) || '/'
  const parsed = new URL(raw, 'https://reader.invalid')
  const path = parsed.pathname
  const anchor = parsed.searchParams.get('anchor')
  const token = ++navigation, epoch = generation
  cleanPage(); route.path = path; error.value = ''; menu.value = false
  if (path === '/') { loading.value = false; document.title = 'Study Reader'; return }
  const reference = pages.value.find(p => p.path === path)
  if (!reference) { error.value = '没有找到这一页，请从章节列表选择。'; return }
  const controller = new AbortController(); request = controller; loading.value = true
  const isCurrent = () => token === navigation && epoch === generation
  try {
    const data = await loadPage(manifest.value, reference, controller.signal)
    if (!isCurrent()) return
    page.value = data; document.title = data.title + ' · Study Reader'
    await nextTick()
    if (!isCurrent()) return
    for (const node of article.value?.querySelectorAll<HTMLElement>('[data-diagram-id]') || []) {
      const id = node.dataset.diagramId!
      if (!data.diagrams[id]) continue
      const host = document.createElement('div')
      node.replaceWith(host)
      const app = createApp(StudyDiagram, { id })
      app.provide('study-diagrams', data.diagrams).mount(host)
      diagrams.push(app)
    }
    headings.value = [...(article.value?.querySelectorAll('h2') || [])].map(h => ({ id: h.id, title: h.textContent?.replace(/\u200b/g, '').trim() || '' }))
    await contentUpdated()
    await Promise.all([...(article.value?.querySelectorAll<HTMLImageElement>('img[data-private-src]') || [])].map(async img => {
      const name = img.dataset.privateSrc!
      if (!/^assets\/[a-zA-Z0-9._-]+$/.test(name)) throw Error('图片路径无效。')
      const response = await privateObject(`releases/${manifest.value!.release}/${name}`, controller.signal)
      const blob = await response.blob()
      if (!isCurrent()) return
      const url = URL.createObjectURL(blob); urls.push(url); img.src = url
    }))
    if (!isCurrent()) return
    if (anchor) document.getElementById(anchor)?.scrollIntoView()
    else window.scrollTo(0, 0)
  } catch (e) {
    if (isCurrent() && (e as Error).name !== 'AbortError') error.value = (e as Error).message
  } finally { if (isCurrent()) loading.value = false }
}
function documentClick(event: MouseEvent) {
  const target = (event.target as HTMLElement).closest<HTMLAnchorElement>('a')
  if (target && article.value?.contains(target)) {
    const link = target.getAttribute('href') || ''
    if (link.startsWith('#')) {
      event.preventDefault(); document.getElementById(decodeURIComponent(link.slice(1)))?.scrollIntoView()
    } else if (link.startsWith('/notes/') || link.startsWith('/foundations/')) {
      event.preventDefault()
      const [path, anchor] = link.split('#')
      go(path + (anchor ? '?anchor=' + encodeURIComponent(anchor) : ''))
    } else if (/^https?:\/\//.test(link)) { target.rel = 'noopener noreferrer'; target.target = '_blank' }
  }
  const copy = (event.target as HTMLElement).closest('button.copy')
  if (copy) {
    const text = copy.parentElement?.querySelector('code')?.textContent || ''
    navigator.clipboard.writeText(text).then(() => {
      copy.setAttribute('aria-label', '已复制')
      copy.classList.add('copied')
      setTimeout(() => copy.classList.remove('copied'), 1500)
    }).catch(() => copy.setAttribute('aria-label', '复制失败，请手动选择代码'))
  }
}
async function search() {
  const term = query.value.trim().toLocaleLowerCase()
  const run = ++searchGeneration, epoch = generation, catalogue = manifest.value
  searchRequest?.abort(); searchBusy.value = false
  results.value = []; searchError.value = ''
  if (!term || !catalogue) return
  const controller = new AbortController(); searchRequest = controller
  searchBusy.value = true
  try {
    const matches = []
    for (const reference of catalogue.pages) {
      const data = await loadPage(catalogue, reference, controller.signal)
      if (run !== searchGeneration || epoch !== generation) return
      const position = data.text.toLocaleLowerCase().indexOf(term)
      if (position >= 0 || data.title.toLocaleLowerCase().includes(term))
        matches.push({ path: reference.path, title: reference.title, snippet: data.text.slice(Math.max(0, position - 40), Math.max(0, position - 40) + 180) })
    }
    results.value = matches
  } catch (e) { if (run === searchGeneration && epoch === generation && (e as Error).name !== 'AbortError') searchError.value = (e as Error).message }
  finally { if (run === searchGeneration) searchBusy.value = false }
}
function theme() { isDark.value = !isDark.value }
function scrollToHeading(id: string) { document.getElementById(id)?.scrollIntoView() }
watch(isDark, value => {
  document.documentElement.classList.toggle('dark', value)
  localStorage.setItem('reader-theme', value ? 'dark' : 'light')
})
onMounted(async () => {
  isDark.value = localStorage.getItem('reader-theme') === 'dark'
  localStorage.removeItem('os-site-master-key')
  window.addEventListener('hashchange', openRoute)
  if (!supabase) { starting.value = false; return }
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    const event = ++authGeneration
    // Stop old-account work synchronously; SDK calls resume outside its auth lock.
    if ((session?.user.id || '') !== userId.value) clearPrivateState()
    setTimeout(() => { if (event === authGeneration) void setSession(session) }, 0)
  })
  unsubscribe = () => data.subscription.unsubscribe()
})
onBeforeUnmount(() => {
  unsubscribe?.(); window.removeEventListener('hashchange', openRoute); clearPrivateState()
})
</script>

<template>
  <div class="private-reader">
    <header class="reader-header">
      <a href="#/" class="reader-brand">Study Reader</a>
      <span class="reader-header-spacer" />
      <button v-if="ready" class="reader-menu-toggle" @click="menu = !menu" :aria-expanded="menu">章节列表</button>
      <button @click="theme" :aria-label="isDark ? '切换浅色' : '切换深色'">{{ isDark ? '浅色' : '深色' }}</button>
      <template v-if="userId"><span class="reader-account">{{ account }}</span><button @click="logout">退出登录</button></template>
    </header>
    <main v-if="!userId" class="reader-login">
      <section class="reader-login-card">
        <p class="reader-eyebrow">YOUR STUDY SPACE</p>
        <h1>登录后继续学习</h1>
        <p>使用管理员分配的账号，阅读笔记并同步个人批注。</p>
        <p v-if="starting" role="status">正在恢复登录…</p>
        <p v-else-if="!supabase" role="alert">尚未配置后端。请按项目说明填写环境变量后构建。</p>
        <form v-else @submit.prevent="login">
          <label for="reader-email">邮箱</label><input id="reader-email" v-model="email" type="email" autocomplete="username" required>
          <label for="reader-password">密码</label><input id="reader-password" v-model="password" type="password" autocomplete="current-password" required>
          <button class="reader-primary" :disabled="busy || signingOut">{{ signingOut ? '正在退出…' : busy ? '正在登录…' : '登录' }}</button>
          <p v-if="authError" role="alert" class="reader-error">{{ authError }}</p>
        </form>
        <small>账号由管理员创建，此处不开放注册。</small>
      </section>
    </main>
    <template v-else>
      <div v-if="!ready" class="reader-start">
        <p v-if="error" role="alert">{{ error }}</p><p v-else role="status">正在加载你的学习空间…</p>
        <button v-if="error" @click="retry">重试</button>
      </div>
      <template v-else>
        <aside class="reader-sidebar" :class="{ open: menu }" aria-label="章节列表">
          <form class="reader-search" @submit.prevent="search"><label for="reader-search">搜索笔记</label><div><input id="reader-search" v-model="query" type="search"><button :disabled="searchBusy">{{ searchBusy ? '搜索中' : '搜索' }}</button></div></form>
          <template v-if="query.trim()">
            <p v-if="searchError" role="alert">{{ searchError }}</p>
            <a v-for="result in results" :key="result.path" :href="href(result.path)" @click.prevent="go(result.path)"><strong>{{ result.title }}</strong><small>{{ result.snippet }}</small></a>
            <p v-if="!results.length && !searchBusy">输入关键词后搜索。</p>
          </template>
          <template v-else>
            <a href="#/" @click="menu = false">首页</a>
            <h2>Lectures</h2><a v-for="item in lectures" :key="item.path" :href="href(item.path)" :aria-current="route.path === item.path ? 'page' : undefined" @click="menu = false">{{ item.title }}</a>
            <h2>Foundations</h2><a v-for="item in foundations" :key="item.path" :href="href(item.path)" :aria-current="route.path === item.path ? 'page' : undefined" @click="menu = false">{{ item.title }}</a>
          </template>
        </aside>
        <div class="reader-main">
          <SyncPanel :pages="pages" />
          <p v-if="error" class="reader-error" role="alert">{{ error }} <button @click="openRoute">重新加载</button></p>
          <p v-if="loading" class="reader-loading" role="status">正在加载内容…</p>
          <section v-if="route.path === '/'" class="reader-home">
            <p class="reader-eyebrow">COURSE NOTES</p><h1>Operating Systems</h1><p>CSC3150 · Fall 2026</p>
            <div class="lec-grid"><a v-for="(item, i) in lectures" :key="item.path" class="lec-card" :href="href(item.path)"><span class="lec-num">{{ String(i + 1).padStart(2, '0') }}</span><span class="lec-body"><span class="lec-title">{{ item.title }}</span></span></a></div>
          </section>
          <div v-else class="VPDoc has-aside">
            <div class="content-container">
              <ReadingTools v-if="page" :key="route.path" />
              <article ref="article" class="vp-doc" @click="documentClick" v-html="safeHtml" />
              <nav v-if="page && (prev || next)" class="reader-pagination" aria-label="课程翻页"><a v-if="prev" :href="href(prev.path)">← {{ prev.title }}</a><a v-if="next" :href="href(next.path)">{{ next.title }} →</a></nav>
            </div>
          </div>
        </div>
        <aside v-if="page" class="reader-outline" aria-label="本讲大纲"><h2>本讲大纲</h2><a v-for="h in headings" :key="h.id" :href="'#' + h.id" @click.prevent="scrollToHeading(h.id)">{{ h.title }}</a></aside>
      </template>
    </template>
  </div>
</template>
