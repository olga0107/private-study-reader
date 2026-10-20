<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute } from 'vitepress'
import { getStroke } from 'perfect-freehand'
import { isSyncActive, readInk, writeInk, subscribeSync } from '../../../app/src/backend/sync'
import { clone, same } from '../../../app/src/backend/sync-model.mjs'

type Pt = [number, number, number]
type StrokeT = 'pen' | 'hl'
interface Stroke { c: string; s: number; t: StrokeT; pts: Pt[] }
type Op = { kind: 'add'; stroke: Stroke } | { kind: 'erase'; items: Stroke[] }

const active = ref(false)
const tool = ref<'pen' | 'hl' | 'eraser'>('pen')
const color = ref('#1a1a1a')
const penSize = ref(5)
const colors = ['#1a1a1a', '#2563eb', '#dc2626', '#16a34a', '#b45309']
const hlColors = ['#fde047', '#86efac', '#fda4af', '#93c5fd']
const hlColor = ref('#fde047')

const strokes = ref<Stroke[]>([])
const storageError = ref('')
let unsubscribeSync: (() => void) | undefined
let sourceSnapshot: any = null
let displayMeta: { vw: number; fs: number } | null = null
let loadedPage = ''
let saving = false
const undoStack = ref<Op[]>([])
const redoStack = ref<Op[]>([])

let baseCv: HTMLCanvasElement | null = null
let liveCv: HTMLCanvasElement | null = null
let wrap: HTMLElement | null = null
let drawing = false
let activePointer = -1
let current: Stroke | null = null
let erasedNow: Stroke[] = []
let raf = 0
const route = useRoute()

const PEN_OPTS = { thinning: 0.65, smoothing: 0.65, streamline: 0.35, simulatePressure: false, last: true }
const HL_OPTS = { thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last: true }

function storageKey() { return 'os-ink:' + location.pathname }

function readFs() {
  try { return JSON.parse(localStorage.getItem('os-reading') || '{}').size || 17 } catch { return 17 }
}

function inkMeta() {
  return { vw: document.documentElement.clientWidth, fs: readFs() }
}

async function save() {
  const snapshot = clone({ v: 1, ...inkMeta(), strokes: strokes.value })
  try {
    saving = true
    if (isSyncActive()) await writeInk(loadedPage || route.path, snapshot, sourceSnapshot)
    else localStorage.setItem(storageKey(), JSON.stringify(snapshot))
    sourceSnapshot = clone(snapshot)
    displayMeta = inkMeta()
    storageError.value = ''
  } catch {
    storageError.value = '手写未保存：浏览器存储不可用或已满，请立即导出本页批注。'
  } finally { saving = false }
}

function rescaleDisplayedStrokesIfNeeded() {
  if (!displayMeta) return
  const { vw, fs } = inkMeta()
  const rx = vw / displayMeta.vw
  const ry = fs / displayMeta.fs
  if (Math.abs(rx - 1) > 0.02 || Math.abs(ry - 1) > 0.02) {
    for (const st of strokes.value) st.pts = st.pts.map(([x, y, p]) => [x * rx, y * ry, p] as Pt)
    displayMeta = { vw, fs }
  }
}

function storedSnapshot() {
  return isSyncActive() ? readInk(route.path) : JSON.parse(localStorage.getItem(storageKey()) || 'null')
}
function load() {
  strokes.value = []
  undoStack.value = []
  redoStack.value = []
  loadedPage = route.path
  try {
    const raw = storedSnapshot()
    sourceSnapshot = raw
    if (raw && Array.isArray(raw.strokes)) strokes.value = clone(raw.strokes)
    displayMeta = raw?.vw && raw?.fs ? { vw: raw.vw, fs: raw.fs } : inkMeta()
    storageError.value = ''
  } catch { storageError.value = '无法读取本页手写记录，请先导出账号备份。' }
  rescaleDisplayedStrokesIfNeeded()
  nextTick(redrawBase)
}
function remoteChanged() {
  if (drawing || saving || loadedPage !== route.path) return
  try { if (!same(storedSnapshot(), sourceSnapshot)) load() } catch {}
}

function isDark() { return document.documentElement.classList.contains('dark') }

function polygonPath(pts: number[][]): Path2D {
  const p = new Path2D()
  if (!pts.length) return p
  p.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1])
  p.closePath()
  return p
}

function strokePath(st: Stroke): Path2D {
  const size = st.t === 'hl' ? 22 : st.s
  const outline = getStroke(st.pts, { size, ...(st.t === 'hl' ? HL_OPTS : PEN_OPTS) })
  return polygonPath(outline)
}

function paintStroke(ctx: CanvasRenderingContext2D, st: Stroke) {
  ctx.globalCompositeOperation = st.t === 'hl' ? (isDark() ? 'screen' : 'multiply') : 'source-over'
  ctx.globalAlpha = st.t === 'hl' ? (isDark() ? 0.45 : 0.4) : 1
  ctx.fillStyle = st.c
  ctx.fill(strokePath(st))
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}

function setupCanvas(cv: HTMLCanvasElement, w: number, h: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  cv.style.width = w + 'px'
  cv.style.height = h + 'px'
}

function offsetCtx(cv: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const ctx = cv.getContext('2d', { desynchronized: true })!
  ctx.setTransform(dpr, 0, 0, dpr, -window.scrollX * dpr, -window.scrollY * dpr)
  return ctx
}

function measure() {
  if (!wrap || !baseCv || !liveCv) return
  rescaleDisplayedStrokesIfNeeded()
  setupCanvas(baseCv, window.innerWidth, window.innerHeight)
  setupCanvas(liveCv, window.innerWidth, window.innerHeight)
  redrawBase()
}

function redrawBase() {
  if (!baseCv) return
  const ctx = offsetCtx(baseCv)
  ctx.clearRect(window.scrollX, window.scrollY, window.innerWidth, window.innerHeight)
  for (const st of strokes.value) paintStroke(ctx, st)
}

let baseRaf = 0
function scheduleBase() {
  cancelAnimationFrame(baseRaf)
  baseRaf = requestAnimationFrame(redrawBase)
}

function redrawLive() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => {
    if (!liveCv) return
    const ctx = offsetCtx(liveCv)
    ctx.clearRect(window.scrollX, window.scrollY, window.innerWidth, window.innerHeight)
    if (current && current.pts.length > 1) paintStroke(ctx, current)
  })
}

function docPoint(e: PointerEvent): Pt {
  const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5
  return [e.clientX + window.scrollX, e.clientY + window.scrollY, p]
}

function newStroke(pt: Pt): Stroke {
  return { c: tool.value === 'hl' ? hlColor.value : color.value, s: penSize.value, t: tool.value === 'hl' ? 'hl' : 'pen', pts: [pt] }
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx, cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

function eraseAt(pt: Pt) {
  const [x, y] = pt
  const hit: Stroke[] = []
  strokes.value = strokes.value.filter((st) => {
    const threshold = (st.t === 'hl' ? 11 : st.s / 2) + 8
    let found = false
    for (let i = 1; i < st.pts.length && !found; i++) {
      if (distToSeg(x, y, st.pts[i - 1][0], st.pts[i - 1][1], st.pts[i][0], st.pts[i][1]) < threshold) found = true
    }
    if (found) hit.push(st)
    return !found
  })
  if (hit.length) {
    erasedNow.push(...hit)
    redrawBase()
  }
}

let touchScroll: { id: number; y: number } | null = null

function onDown(e: PointerEvent) {
  if (!active.value) return
  if (saving) { e.preventDefault(); return }
  const target = e.target as HTMLElement | null
  if (target?.closest?.('.ink-panel, .reading-tools, .sync-panel, .reader-header, .reader-sidebar, .reader-outline, .reader-pagination')) return
  if (drawing) { e.preventDefault(); return }
  if (e.pointerType === 'touch') {
    // 批注模式下 touch-action: none，手指滚动由 JS 手动转发
    touchScroll = { id: e.pointerId, y: e.clientY }
    e.preventDefault()
    return
  }
  if (e.button !== 0 && e.pointerType === 'mouse') return
  drawing = true
  activePointer = e.pointerId
  erasedNow = []
  if (tool.value === 'eraser') {
    eraseAt(docPoint(e))
  } else {
    current = newStroke(docPoint(e))
    redrawLive()
  }
  e.preventDefault()
}

function onMove(e: PointerEvent) {
  if (touchScroll && e.pointerId === touchScroll.id) {
    window.scrollBy(0, touchScroll.y - e.clientY)
    touchScroll.y = e.clientY
    e.preventDefault()
    return
  }
  if (!drawing || e.pointerId !== activePointer) return
  const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : []
  const events = coalesced && coalesced.length ? coalesced : [e]
  if (tool.value === 'eraser') {
    for (const ev of events) eraseAt(docPoint(ev))
  } else if (current) {
    for (const ev of events) current.pts.push(docPoint(ev))
    redrawLive()
  }
  e.preventDefault()
}

function onUp(e: PointerEvent) {
  if (touchScroll && e.pointerId === touchScroll.id) {
    touchScroll = null
    return
  }
  if (!drawing || e.pointerId !== activePointer) return
  drawing = false
  activePointer = -1
  if (tool.value === 'eraser') {
    if (erasedNow.length) {
      undoStack.value.push({ kind: 'erase', items: erasedNow })
      redoStack.value = []
      save()
    }
    erasedNow = []
  } else if (current) {
    if (current.pts.length === 1) current.pts.push([current.pts[0][0] + 0.1, current.pts[0][1], current.pts[0][2]])
    strokes.value.push(current)
    undoStack.value.push({ kind: 'add', stroke: current })
    redoStack.value = []
    current = null
    save()
    redrawBase()
    if (liveCv) {
      const ctx = offsetCtx(liveCv)
      ctx.clearRect(window.scrollX, window.scrollY, window.innerWidth, window.innerHeight)
    }
  }
}

function undo() {
  if (saving) return
  const op = undoStack.value.pop()
  if (!op) return
  if (op.kind === 'add') {
    strokes.value = strokes.value.filter((s) => s !== op.stroke)
  } else {
    strokes.value.push(...op.items)
  }
  redoStack.value.push(op)
  save(); redrawBase()
}

function redo() {
  if (saving) return
  const op = redoStack.value.pop()
  if (!op) return
  if (op.kind === 'add') {
    strokes.value.push(op.stroke)
  } else {
    strokes.value = strokes.value.filter((s) => !op.items.includes(s))
  }
  undoStack.value.push(op)
  save(); redrawBase()
}

function clearAll() {
  if (saving) return
  if (!strokes.value.length) return
  undoStack.value.push({ kind: 'erase', items: [...strokes.value] })
  redoStack.value = []
  strokes.value = []
  save(); redrawBase()
}

function exportJSON() {
  const blob = new Blob([JSON.stringify({ v: 1, page: loadedPage || route.path, ...inkMeta(), strokes: strokes.value }, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'ink' + location.pathname.replace(/\//g, '-') + '.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

function toggle(on?: boolean) {
  active.value = on ?? !active.value
  document.documentElement.classList.toggle('ink-on', active.value)
  try { localStorage.setItem('os-ink-mode', JSON.stringify(active.value)) } catch {}
}

watch(active, (v) => {
  if (v) nextTick(measure)
})

watch(() => route.path, () => { nextTick(() => { measure(); load() }) })

let resizeObs: ResizeObserver | null = null

onMounted(async () => {
  await nextTick()
  wrap = document.getElementById('ink-wrap')
  baseCv = document.getElementById('ink-base') as HTMLCanvasElement
  liveCv = document.getElementById('ink-live') as HTMLCanvasElement
  try { active.value = JSON.parse(localStorage.getItem('os-ink-mode') || 'false') } catch {}
  document.documentElement.classList.toggle('ink-on', active.value)
  load()
  unsubscribeSync = subscribeSync(remoteChanged)
  measure()
  // 字号调整等排版变化会改变 body 尺寸，借此触发坐标换算
  resizeObs = new ResizeObserver(() => measure())
  resizeObs.observe(document.body)
  window.addEventListener('scroll', scheduleBase, { passive: true })
  window.addEventListener('resize', measure)
  document.addEventListener('pointerdown', onDown, { capture: true })
  document.addEventListener('pointermove', onMove, { capture: true })
  document.addEventListener('pointerup', onUp, { capture: true })
  document.addEventListener('pointercancel', onUp, { capture: true })
})

onBeforeUnmount(() => {
  unsubscribeSync?.()
  cancelAnimationFrame(raf)
  cancelAnimationFrame(baseRaf)
  resizeObs?.disconnect()
  document.documentElement.classList.remove('ink-on')
  window.removeEventListener('scroll', scheduleBase)
  window.removeEventListener('resize', measure)
  document.removeEventListener('pointerdown', onDown, { capture: true })
  document.removeEventListener('pointermove', onMove, { capture: true })
  document.removeEventListener('pointerup', onUp, { capture: true })
  document.removeEventListener('pointercancel', onUp, { capture: true })
})
</script>

<template>
  <p v-if="storageError" role="alert">{{ storageError }}</p>
  <button type="button" class="ink-toggle" :aria-pressed="active" @click="toggle()">
    {{ active ? '退出批注' : '手写批注' }}
  </button>

  <Teleport to="body">
    <div id="ink-wrap" class="ink-wrap" :class="{ on: active }" aria-hidden="true">
      <canvas id="ink-base" />
      <canvas id="ink-live" />
    </div>

    <div v-if="active" class="ink-panel" role="toolbar" aria-label="手写批注工具">
      <button :class="{ sel: tool === 'pen' }" @click="tool = 'pen'" title="笔">✒️</button>
      <button :class="{ sel: tool === 'hl' }" @click="tool = 'hl'" title="荧光笔">🖍️</button>
      <button :class="{ sel: tool === 'eraser' }" @click="tool = 'eraser'" title="橡皮">⌫</button>
      <span class="ink-sep" />
      <template v-if="tool === 'pen'">
        <button v-for="c in colors" :key="c" class="ink-dot" :class="{ sel: color === c }" :style="{ background: c }" :aria-label="'颜色 ' + c" @click="color = c" />
        <span class="ink-sep" />
        <button @click="penSize = Math.max(2, penSize - 2)" title="细">−</button>
        <button @click="penSize = Math.min(12, penSize + 2)" title="粗">＋</button>
      </template>
      <template v-else-if="tool === 'hl'">
        <button v-for="c in hlColors" :key="c" class="ink-dot" :class="{ sel: hlColor === c }" :style="{ background: c }" :aria-label="'荧光 ' + c" @click="hlColor = c" />
      </template>
      <span class="ink-sep" />
      <button :disabled="!undoStack.length" title="撤销" @click="undo">↩</button>
      <button :disabled="!redoStack.length" title="重做" @click="redo">↪</button>
      <button :disabled="!strokes.length" title="清空本页" @click="clearAll">🗑</button>
      <button :disabled="!strokes.length" title="导出批注" @click="exportJSON">⤓</button>
      <button title="退出批注" @click="toggle(false)">✕</button>
    </div>
  </Teleport>
</template>

<style scoped>
.ink-toggle {
  border: none;
  border-radius: 7px;
  padding: 7px 10px;
  font-size: 13px;
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  white-space: nowrap;
}
.ink-toggle:hover { background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); }
.ink-toggle[aria-pressed='true'] {
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
}
.ink-wrap {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 25;
  display: none;
}
.ink-wrap.on { display: block; }
.ink-wrap canvas {
  position: absolute;
  top: 0;
  left: 0;
}
.ink-panel {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-radius: 999px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  z-index: 60;
}
.ink-panel button {
  border: none;
  background: transparent;
  font-size: 15px;
  padding: 4px 6px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--vp-c-text-1);
}
.ink-panel button.sel { background: var(--vp-c-brand-soft); }
.ink-panel button:disabled { opacity: 0.35; cursor: default; }
.ink-dot {
  width: 18px;
  height: 18px;
  border-radius: 50% !important;
  padding: 0 !important;
  border: 2px solid transparent !important;
}
.ink-dot.sel { border-color: var(--vp-c-text-1) !important; }
.ink-sep {
  width: 1px;
  height: 18px;
  background: var(--vp-c-divider);
}
</style>
