type ImageCache = {
  load(key: string, signal: AbortSignal): Promise<Blob>
  remove(key: string): void
}

const placeholder = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E'

export function mountPrivateImages(root: HTMLElement, release: string, cache: ImageCache) {
  const images = [...root.querySelectorAll<HTMLImageElement>('img[data-private-src]')]
  const nearby = new Set<HTMLImageElement>(), active = new Map<HTMLImageElement, AbortController>()
  const urls = new Set<string>(), retries = new Map<HTMLImageElement, HTMLButtonElement>()
  let disposed = false

  function distance(img: HTMLImageElement) {
    const box = img.getBoundingClientRect()
    return Math.max(0, box.top - innerHeight, -box.bottom)
  }
  function pump() {
    if (disposed) return
    const waiting = images.filter(img => nearby.has(img) && !active.has(img) && img.dataset.imageState === 'waiting')
      .sort((a, b) => distance(a) - distance(b))
    while (active.size < 2 && waiting.length) void load(waiting.shift()!)
  }
  async function load(img: HTMLImageElement) {
    const controller = new AbortController()
    active.set(img, controller)
    img.dataset.imageState = 'loading'; img.setAttribute('aria-busy', 'true')
    const timeout = setTimeout(() => controller.abort(new DOMException('Image timed out', 'TimeoutError')), 30000)
    let url: string | undefined
    const name = img.dataset.privateSrc || ''
    const key = `releases/${release}/${name}`
    try {
      if (!/^assets\/[a-zA-Z0-9._-]+$/.test(name)) throw Error('Invalid image path')
      const blob = await cache.load(key, controller.signal)
      if (disposed) return
      controller.signal.throwIfAborted()
      url = URL.createObjectURL(blob); urls.add(url); img.src = url
      await img.decode()
      if (disposed) return
      controller.signal.throwIfAborted()
      img.dataset.imageState = 'ready'
      observer?.unobserve(img); nearby.delete(img)
    } catch (error) {
      if (disposed) return
      if (url) {
        URL.revokeObjectURL(url); urls.delete(url)
        if ((error as Error).name !== 'AbortError') cache.remove(key)
      }
      img.src = placeholder
      if ((error as Error).name === 'AbortError') {
        img.dataset.imageState = 'waiting'
      } else {
        img.dataset.imageState = 'error'
        retries.get(img)!.hidden = false
      }
    } finally {
      clearTimeout(timeout)
      active.delete(img)
      if (!disposed) { img.setAttribute('aria-busy', 'false'); pump() }
    }
  }
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    for (const entry of entries) {
      const img = entry.target as HTMLImageElement
      if (entry.isIntersecting) nearby.add(img)
      else { nearby.delete(img); active.get(img)?.abort() }
    }
    pump()
  }, { rootMargin: '600px 0px' })

  for (const img of images) {
    // Exported dimensions reserve the same space before and after downloading.
    const width = Number(img.getAttribute('width')), height = Number(img.getAttribute('height'))
    if (width > 0 && height > 0) img.style.aspectRatio = `${width} / ${height}`
    img.classList.add('reader-private-image')
    img.src = placeholder; img.loading = 'eager'; img.decoding = 'async'
    img.dataset.imageState = 'waiting'
    const retry = document.createElement('button')
    retry.type = 'button'; retry.className = 'reader-image-retry'; retry.hidden = true
    retry.textContent = 'Retry image'
    retry.setAttribute('aria-label', `Retry image: ${img.alt || 'Course illustration'}`)
    retry.onclick = () => { retry.hidden = true; img.dataset.imageState = 'waiting'; nearby.add(img); pump() }
    img.after(retry); retries.set(img, retry)
    if (observer) observer.observe(img)
    else nearby.add(img)
  }
  if (!observer) pump()
  return () => {
    disposed = true; observer?.disconnect()
    for (const controller of active.values()) controller.abort()
    for (const url of urls) URL.revokeObjectURL(url)
    for (const button of retries.values()) { button.onclick = null; button.remove() }
    nearby.clear(); urls.clear()
  }
}
