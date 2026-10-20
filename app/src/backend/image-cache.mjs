// Private image bytes live only in this tab's authenticated session.
export function createImageCache(fetchBlob, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const entries = new Map(), requests = new Set()
  let bytes = 0, generation = 0
  const aborted = signal => {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError')
  }
  function remove(key) {
    const blob = entries.get(key)
    if (blob) { bytes -= blob.size; entries.delete(key) }
  }
  return {
    async load(key, signal) {
      aborted(signal)
      const cached = entries.get(key)
      if (cached) {
        entries.delete(key); entries.set(key, cached)
        return cached
      }
      const epoch = generation, controller = new AbortController()
      const cancel = () => controller.abort(signal.reason)
      signal?.addEventListener('abort', cancel, { once: true })
      requests.add(controller)
      try {
        const blob = await fetchBlob(key, controller.signal)
        aborted(controller.signal)
        if (epoch !== generation) throw new DOMException('Session changed', 'AbortError')
        if (blob.size <= maxBytes) {
          remove(key)
          while (bytes + blob.size > maxBytes && entries.size) remove(entries.keys().next().value)
          entries.set(key, blob); bytes += blob.size
        }
        return blob
      } finally {
        signal?.removeEventListener('abort', cancel)
        requests.delete(controller)
      }
    },
    remove,
    clear() {
      generation++
      for (const controller of requests) controller.abort()
      requests.clear(); entries.clear(); bytes = 0
    },
  }
}
