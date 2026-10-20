<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, createApp, type App as VueApp } from 'vue'
import DOMPurify from 'dompurify'
import { supabase } from './backend/client'
import { loadManifest, loadPage, privateObject, type Manifest, type Page, type PageRef } from './backend/content'
import { createImageCache } from './backend/image-cache.mjs'
import { mountPrivateImages } from './backend/images'
import { initSync, stopSync } from './backend/sync'
import { route, isDark, contentUpdated } from './reader-context'
import ReadingTools from '../../.vitepress/theme/components/ReadingTools.vue'
import StudyDiagram from '../../.vitepress/theme/components/StudyDiagram.vue'
import SyncPanel from './components/SyncPanel.vue'
import ReaderIcon from './components/ReaderIcon.vue'

const email = ref(''), password = ref(''), authError = ref(''), busy = ref(false), signingOut = ref(false)
const userId = ref(''), account = ref(''), ready = ref(false), starting = ref(true)
const manifest = ref<Manifest | null>(null), page = ref<Page | null>(null), error = ref(''), loading = ref(false)
const menu = ref(false), query = ref(''), searchBusy = ref(false), searchError = ref(''), searchedQuery = ref('')
const showPassword = ref(false), accountOpen = ref(false), lastPagePath = ref('')
const sidebar = ref<HTMLElement>(), searchInput = ref<HTMLInputElement>(), menuButton = ref<HTMLButtonElement>(), accountControl = ref<HTMLElement>()
const accountButton = ref<HTMLButtonElement>()
const results = ref<{ path: string; title: string; snippet: string }[]>([])
const article = ref<HTMLElement>(), headings = ref<{id: string; title: string}[]>([])
let generation = 0, navigation = 0, searchGeneration = 0, authGeneration = 0, request: AbortController | null = null
let searchRequest: AbortController | null = null
let diagrams: VueApp[] = [], unsubscribe: (() => void) | undefined, stopImages: (() => void) | undefined
const imageCache = createImageCache(async (key: string, signal: AbortSignal) => {
  const response = await privateObject(key, signal)
  return response.blob()
})
const pages = computed(() => manifest.value?.pages || [])
const lectures = computed(() => pages.value.filter(p => p.kind === 'notes'))
const foundations = computed(() => pages.value.filter(p => p.kind === 'foundations'))
const resumePage = computed(() => pages.value.find(p => p.path === lastPagePath.value))
const activePage = computed(() => pages.value.find(p => p.path === route.path))
function chapterTitle(title: string) { return title.replace(/^Lec(?:ture)?\s*\d+\s*[·.:]\s*/i, '') }
const lectureIndex = computed(() => lectures.value.findIndex(p => p.path === route.path))
const prev = computed(() => lectureIndex.value > 0 ? lectures.value[lectureIndex.value - 1] : null)
const next = computed(() => lectureIndex.value >= 0 ? lectures.value[lectureIndex.value + 1] : null)
const safeHtml = computed(() => DOMPurify.sanitize(page.value?.html || '', {
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'style'],
  FORBID_ATTR: ['src', 'srcset'],
}))
function cleanPage() {
  request?.abort()
  stopImages?.(); stopImages = undefined
  diagrams.forEach(app => app.unmount()); diagrams = []
  page.value = null; headings.value = []
  loading.value = false
}
function clearPrivateState() {
  generation++; navigation++; searchGeneration++
  searchRequest?.abort(); searchBusy.value = false
  stopSync(); cleanPage()
  imageCache.clear()
  ready.value = false; manifest.value = null; query.value = ''; results.value = []; searchedQuery.value = ''
  menu.value = false; accountOpen.value = false; lastPagePath.value = ''; showPassword.value = false
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
  try { lastPagePath.value = localStorage.getItem(`olga-reading:${id}`) || '' } catch {}
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
    if (error) authError.value = 'Unable to sign in. Check your email and password.'
  } catch { authError.value = 'Connection failed. Please try again.' }
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
  menu.value = false; clearSearch()
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
  if (path === '/') { loading.value = false; document.title = 'olga’s study · Operating Systems'; return }
  const reference = pages.value.find(p => p.path === path)
  if (!reference) { error.value = 'Page not found. Choose a chapter.'; return }
  const controller = new AbortController(); request = controller; loading.value = true
  const isCurrent = () => token === navigation && epoch === generation
  try {
    const data = await loadPage(manifest.value, reference, controller.signal)
    if (!isCurrent()) return
    page.value = data; lastPagePath.value = reference.path
    try { localStorage.setItem(`olga-reading:${userId.value}`, reference.path) } catch {}
    document.title = data.title + ' · olga’s study'
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
    if (!anchor) window.scrollTo(0, 0)
    await contentUpdated()
    if (!isCurrent()) return
    stopImages = mountPrivateImages(article.value!, manifest.value!.release, imageCache)
    if (anchor) document.getElementById(anchor)?.scrollIntoView()
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
      copy.setAttribute('aria-label', 'Copied')
      copy.classList.add('copied')
      setTimeout(() => copy.classList.remove('copied'), 1500)
    }).catch(() => copy.setAttribute('aria-label', 'Copy failed. Select the code to copy it.'))
  }
}
async function search() {
  const term = query.value.trim().toLocaleLowerCase()
  const run = ++searchGeneration, epoch = generation, catalogue = manifest.value
  searchRequest?.abort(); searchBusy.value = false
  results.value = []; searchError.value = ''
  searchedQuery.value = query.value.trim()
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
function clearSearch() {
  searchGeneration++; searchRequest?.abort(); query.value = ''; searchedQuery.value = ''
  results.value = []; searchBusy.value = false; searchError.value = ''
}
function dismissAccount(event: PointerEvent) {
  if (!accountControl.value?.contains(event.target as Node)) accountOpen.value = false
}
function readerKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && ready.value) {
    event.preventDefault()
    if (matchMedia('(max-width: 959px)').matches) menu.value = true
    else window.dispatchEvent(new Event('reader-show-navigation'))
    nextTick(() => searchInput.value?.focus())
  }
  if (event.key === 'Escape') {
    if (accountOpen.value) { accountOpen.value = false; accountButton.value?.focus() }
    if (menu.value) { menu.value = false; nextTick(() => menuButton.value?.focus()) }
    else if (document.activeElement === searchInput.value) clearSearch()
  }
  if (event.key === 'Tab' && menu.value) {
    const controls = [...(sidebar.value?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input') || [])]
      .filter(node => node.getClientRects().length)
    const first = controls[0], last = controls[controls.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
}
function resizeReader() { if (!matchMedia('(max-width: 959px)').matches) menu.value = false }
watch(menu, async value => {
  document.body.classList.toggle('reader-nav-open', value)
  await nextTick()
  if (value) searchInput.value?.focus()
  else menuButton.value?.focus()
})
watch(query, value => { if (!value.trim() && (searchedQuery.value || searchBusy.value)) clearSearch() })
function focusContent() { document.getElementById('reader-content')?.focus() }
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
  window.addEventListener('keydown', readerKey)
  window.addEventListener('resize', resizeReader)
  document.addEventListener('pointerdown', dismissAccount)
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
  window.removeEventListener('keydown', readerKey); window.removeEventListener('resize', resizeReader)
  document.removeEventListener('pointerdown', dismissAccount); document.body.classList.remove('reader-nav-open')
})
</script>

<template>
  <div class="private-reader" :class="{ 'reader-at-home': ready && route.path === '/' }">
    <a class="reader-skip" href="#reader-content" @click.prevent="focusContent()">Skip to content</a>
    <header class="reader-header" :inert="menu">
      <a href="#/" class="reader-brand" aria-label="olga’s study home" @click="menu = false"><span class="brand-monogram">o.</span><span class="brand-name">olga<span class="brand-apostrophe">’s</span><small>study notes</small></span></a>
      <span v-if="ready && route.path !== '/'" class="header-course">Operating Systems <span>/ CSC3150</span></span>
      <span class="reader-header-spacer" />
      <button v-if="ready" ref="menuButton" class="reader-menu-toggle reader-icon-button" @click="menu = !menu" :aria-expanded="menu" aria-controls="reader-navigation" aria-label="Open chapters"><ReaderIcon name="menu" /></button>
      <button class="reader-icon-button" @click="theme" :aria-label="isDark ? 'Light mode' : 'Dark mode'" :title="isDark ? 'Light mode' : 'Dark mode'"><ReaderIcon :name="isDark ? 'sun' : 'moon'" /></button>
      <div v-if="userId" ref="accountControl" class="reader-account-control">
        <button ref="accountButton" class="reader-icon-button" :aria-expanded="accountOpen" aria-controls="reader-account-menu" aria-label="Account" @click="accountOpen = !accountOpen"><ReaderIcon name="user" /></button>
        <div v-if="accountOpen" id="reader-account-menu" class="reader-account-menu"><span>Signed in as</span><p class="reader-account">{{ account }}</p><button @click="logout">Sign out</button></div>
      </div>
    </header>
    <main v-if="!userId" id="reader-content" class="reader-login" tabindex="-1">
      <section class="reader-welcome" aria-labelledby="welcome-title">
        <h1 id="welcome-title">Notes.<br><em>by olga.</em></h1>
      </section>
      <section class="reader-login-card" aria-labelledby="login-title">
        <h2 id="login-title">Sign in</h2>
        <p v-if="starting" role="status">Restoring session…</p>
        <p v-else-if="!supabase" role="alert">Unable to connect. Please try again later.</p>
        <form v-else @submit.prevent="login">
          <label for="reader-email">Email</label><input id="reader-email" v-model="email" type="email" autocomplete="username" placeholder="name@example.com" required>
          <label for="reader-password">Password</label><div class="reader-password-field"><input id="reader-password" v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required><button type="button" :aria-label="showPassword ? 'Hide password' : 'Show password'" :aria-pressed="showPassword" @click="showPassword = !showPassword"><ReaderIcon name="eye" /></button></div>
          <p v-if="authError" id="reader-auth-error" role="alert" class="reader-error">{{ authError }}</p>
          <button class="reader-primary" :disabled="busy || signingOut"><span>{{ signingOut ? 'Signing out…' : busy ? 'Signing in…' : 'Sign in' }}</span><ReaderIcon v-if="!busy && !signingOut" name="arrow" /></button>
        </form>
        <p class="reader-access-note"><ReaderIcon name="lock" /><span>Invite only</span></p>
      </section>
    </main>
    <template v-else>
      <div v-if="!ready" class="reader-start"><p v-if="error" role="alert">{{ error }}</p><p v-else role="status">Opening notes…</p><button v-if="error" @click="retry">Retry</button></div>
      <template v-else>
        <button v-if="menu" class="reader-nav-backdrop" aria-label="Close chapters" tabindex="-1" @click="menu = false; menuButton?.focus()" />
        <aside id="reader-navigation" ref="sidebar" class="reader-sidebar" :class="{ open: menu }" :role="menu ? 'dialog' : undefined" :aria-modal="menu || undefined" aria-label="Chapters">
          <div class="reader-mobile-nav-title"><strong>Chapters</strong><button class="reader-icon-button" aria-label="Close chapters" @click="menu = false; menuButton?.focus()"><ReaderIcon name="close" /></button></div>
          <form class="reader-search" @submit.prevent="search"><label for="reader-search">Search notes</label><div><ReaderIcon name="search" /><input id="reader-search" ref="searchInput" v-model="query" type="search" placeholder="Keyword" autocomplete="off"><button type="submit" :disabled="searchBusy">{{ searchBusy ? 'Searching…' : 'Search' }}</button></div></form>
          <section v-if="searchedQuery || searchBusy" class="reader-search-results" aria-label="Search results" aria-live="polite">
            <div class="reader-results-head"><span>{{ searchBusy ? 'Searching…' : searchError ? 'Search failed' : `${results.length} results` }}</span><button @click="clearSearch(); searchInput?.focus()" aria-label="Clear search"><ReaderIcon name="close" /></button></div>
            <p v-if="searchError" role="alert">{{ searchError }}</p>
            <a v-for="result in results" :key="result.path" :href="href(result.path)" @click.prevent="go(result.path)"><strong>{{ result.title }}</strong><small>{{ result.snippet }}</small></a>
            <p v-if="!results.length && !searchBusy && !searchError">No matches for “{{ searchedQuery }}”. Try another keyword.</p>
          </section>
          <nav aria-label="Course navigation">
            <a class="reader-home-link" href="#/" :aria-current="route.path === '/' ? 'page' : undefined" @click="menu = false"><ReaderIcon name="book" />Overview</a>
            <div class="reader-nav-heading"><h2>Lectures</h2><span>{{ lectures.length }}</span></div>
            <a v-for="(item, i) in lectures" :key="item.path" class="reader-chapter-link" :href="href(item.path)" :aria-current="route.path === item.path ? 'page' : undefined" :aria-label="item.title" @click="menu = false"><span class="reader-chapter-number">{{ String(i + 1).padStart(2, '0') }}</span><span>{{ chapterTitle(item.title) }}</span></a>
            <div class="reader-nav-heading"><h2>Foundations</h2></div><a v-for="item in foundations" :key="item.path" :href="href(item.path)" :aria-current="route.path === item.path ? 'page' : undefined" @click="menu = false">{{ item.title }}</a>
          </nav>
        </aside>
        <main id="reader-content" class="reader-main" :inert="menu" tabindex="-1">
          <SyncPanel :pages="pages" />
          <p v-if="error" class="reader-error" role="alert">{{ error }} <button @click="openRoute">Reload</button></p>
          <p v-if="loading" class="reader-loading" role="status">Loading…</p>
          <section v-if="route.path === '/'" class="reader-home">
            <div class="reader-home-heading"><div><h1>Operating<br>Systems<span class="home-title-dot">.</span></h1><p class="reader-course-meta">CSC3150 <span>Fall 2026</span></p></div></div>
            <a v-if="resumePage" class="reader-resume" :href="href(resumePage.path)"><span><small>Continue reading</small><strong>{{ resumePage.title }}</strong></span><ReaderIcon name="arrow" /></a>
            <div class="reader-index-heading"><h2>Lecture notes</h2><span>{{ lectures.length }} chapters</span></div>
            <div class="lec-grid"><a v-for="(item, i) in lectures" :key="item.path" class="lec-card" :href="href(item.path)"><span class="lec-num">{{ String(i + 1).padStart(2, '0') }}</span><span class="lec-body"><span class="lec-title">{{ chapterTitle(item.title) }}</span></span><ReaderIcon name="arrow" /></a></div>
          </section>
          <div v-else class="VPDoc has-aside">
            <div class="content-container">
              <nav v-if="activePage" class="reader-breadcrumb" aria-label="Breadcrumb"><a href="#/">Overview</a><ReaderIcon name="chevron" /><span>{{ activePage.title }}</span></nav>
              <ReadingTools v-if="page" :key="route.path" />
              <article ref="article" class="vp-doc" @click="documentClick" v-html="safeHtml" />
              <nav v-if="page && (prev || next)" class="reader-pagination" aria-label="Chapter navigation"><a v-if="prev" :href="href(prev.path)"><small>Previous</small><span>{{ prev.title }}</span></a><a v-if="next" :href="href(next.path)"><small>Next</small><span>{{ next.title }}</span><ReaderIcon name="arrow" /></a></nav>
            </div>
          </div>
        </main>
        <aside v-if="page" class="reader-outline" :inert="menu" aria-label="On this page"><h2>On this page</h2><a v-for="h in headings" :key="h.id" :href="'#' + h.id" @click.prevent="scrollToHeading(h.id)">{{ h.title }}</a></aside>
      </template>
    </template>
  </div>
</template>
