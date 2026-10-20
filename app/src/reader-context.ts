import { reactive, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
export const route = reactive({ path: '/' })
export const isDark = ref(false)
const listeners = new Set<() => unknown>()
export function useRoute() { return route }
export function useData() { return { isDark } }
export function onContentUpdated(callback: () => unknown) {
  onMounted(() => listeners.add(callback))
  onBeforeUnmount(() => listeners.delete(callback))
}
export async function contentUpdated() {
  await nextTick()
  for (const callback of listeners) await callback()
}
