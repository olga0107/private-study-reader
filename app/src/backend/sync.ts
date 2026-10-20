import { reactive } from 'vue';
import { supabase } from './client';
import { accountClient } from './session-client.mjs';
import { STORAGE_KEY, validateBackup, mergeMarks } from '../../../.vitepress/theme/annotations/model.mjs';
import { accountKey, canonicalPath, snapshotKey, clone, same, emptyStore, validateStore, validatePayload, editSnapshot, editWithBaseline, lockedMutation, receiveRow, acknowledge, resolveSnapshot } from './sync-model.mjs';

type Kind = 'marks' | 'ink';
type Entry = { page_path: string; kind: Kind; payload: any; revision: number; dirty: boolean; localVersion: number; conflict: any };
type Store = { version: number; userId: string; entries: Record<string, Entry> };
export const syncState = reactive({ userId: '', busy: false, pending: 0, conflicts: [] as Entry[], error: '', offline: false, lastSynced: '' });
let store: Store | null = null;
let generation = 0;
let writable = true;
let interval: ReturnType<typeof setInterval> | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;
let operation: Promise<void> | null = null;
const listeners = new Set<() => void>();
const errorText = (error: unknown) => error instanceof Error ? error.message : '同步暂时失败，批注保留在此设备，请稍后重试。';

export function isSyncActive() { return !!syncState.userId; }
export function subscribeSync(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish() {
  const entries = Object.values(store?.entries ?? {});
  syncState.pending = entries.filter((entry) => entry.dirty).length;
  syncState.conflicts = entries.filter((entry) => entry.conflict).map(clone);
  for (const listener of listeners) listener();
}
function readDisk(): Store {
  if (!store || !syncState.userId) throw Error('请先登录。');
  const raw = localStorage.getItem(accountKey(syncState.userId));
  return raw ? validateStore(JSON.parse(raw), syncState.userId) : emptyStore(syncState.userId);
}
async function update(change: (draft: Store) => void) {
  if (!writable || !store || !syncState.userId) throw Error('本地批注无法安全写入，请先导出备份并检查浏览器存储。');
  const epoch = generation, userId = syncState.userId;
  const current = () => epoch === generation && userId === syncState.userId;
  await lockedMutation(navigator.locks, accountKey(userId), current, readDisk,
    (value: Store) => localStorage.setItem(accountKey(userId), JSON.stringify(value)), change);
  if (!current()) throw Error('登录账号已变化，本次操作未写入其他账号。');
  // A following tab may have committed after our lock was released.
  store = readDisk();
  publish();
}

function schedule() {
  clearTimeout(debounce);
  debounce = setTimeout(() => { void flushSync(); }, 700);
}
export function readMarks(): any[] {
  return Object.values(store?.entries ?? {}).filter((entry) => entry.kind === 'marks').flatMap((entry) => clone(entry.payload));
}
export async function writeMarks(marks: any[], before: any[] = readMarks()) {
  const checked = validateBackup({ version: 1, marks }), baseline = validateBackup({ version: 1, marks: before });
  await update((draft) => {
    const paths = new Set([...baseline.map((mark: any) => mark.path), ...checked.map((mark: any) => mark.path)]);
    for (const path of paths) {
      const before = baseline.filter((mark: any) => mark.path === path), after = checked.filter((mark: any) => mark.path === path);
      if (!same(before, after)) editWithBaseline(draft, path, 'marks', after, before);
    }
  });
  schedule();
}
export function readInk(path: string) { return clone(store?.entries[snapshotKey(path, 'ink')]?.payload ?? { v: 1, strokes: [] }); }
export async function writeInk(path: string, payload: any, baseline?: any) {
  const snapshot = clone(payload), before = baseline ? clone(baseline) : undefined;
  await update((draft) => { editWithBaseline(draft, path, 'ink', snapshot, before); });
  schedule();
}

function refreshFromDisk(event: StorageEvent) {
  if (event.key !== accountKey(syncState.userId) && event.key !== null) return;
  try { store = readDisk(); publish(); void flushSync(); }
  catch (error) { writable = false; syncState.error = errorText(error); }
}
function wake() { void flushSync(); }
function offline() { syncState.offline = true; }
export function stopSync() {
  generation += 1;
  clearInterval(interval);
  clearTimeout(debounce);
  window.removeEventListener('storage', refreshFromDisk);
  window.removeEventListener('online', wake);
  window.removeEventListener('offline', offline);
  window.removeEventListener('focus', wake);
  store = null;
  operation = null;
  writable = true;
  Object.assign(syncState, { userId: '', busy: false, pending: 0, conflicts: [], error: '', offline: false, lastSynced: '' });
}
export async function initSync(userId: string) {
  stopSync();
  syncState.userId = userId;
  store = emptyStore(userId);
  try { store = readDisk(); }
  catch (error) { writable = false; syncState.error = errorText(error); }
  publish();
  window.addEventListener('storage', refreshFromDisk);
  window.addEventListener('online', wake);
  window.addEventListener('offline', offline);
  window.addEventListener('focus', wake);
  interval = setInterval(wake, 30000);
  await flushSync();
}
export async function flushSync(): Promise<void> {
  if (operation) return operation;
  if (!store || !supabase || !writable) return;
  syncState.offline = !navigator.onLine;
  if (syncState.offline) return;
  const session = generation, userId = syncState.userId;
  const current = () => session === generation && userId === syncState.userId;
  const work = async () => {
    syncState.busy = true;
    syncState.error = '';
    try {
      const client = await accountClient(supabase!.auth, import.meta.env.VITE_SUPABASE_URL,
        import.meta.env.VITE_SUPABASE_ANON_KEY, userId, current);
      if (!client || !current()) return;
      // Read in pages: Supabase's response limit must not silently omit old chapters.
      const rows: any[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await client.from('annotations').select('user_id,page_path,kind,payload,revision,updated_at')
          .eq('user_id', userId).order('page_path').order('kind').range(offset, offset + 499);
        if (!current()) return;
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
      await update((draft) => {
        for (const row of rows) {
          if (row.user_id !== userId) throw Error('账号不匹配，同步已停止。');
          receiveRow(draft, row);
        }
      });
      if (!current()) return;
      const pending = Object.values(store!.entries).filter((entry) => entry.dirty && !entry.conflict).map(clone);
      for (const item of pending) {
        if (!current()) return;
        const latest = readDisk().entries[snapshotKey(item.page_path, item.kind)];
        if (!latest?.dirty || latest.conflict) continue;
        const sent = clone(latest);
        const { data, error } = await client.rpc('save_annotation', {
          p_page_path: sent.page_path, p_kind: sent.kind, p_payload: sent.payload, p_expected_revision: sent.revision,
        });
        if (!current()) return;
        if (error) throw error;
        if (!data || typeof data.ok !== 'boolean') throw Error('云端返回了无法识别的保存结果。');
        await update((draft) => {
          if (data.ok) acknowledge(draft, sent, data.row);
          else {
            const local = draft.entries[snapshotKey(sent.page_path, sent.kind)];
            if (local) {
              const remote = data.row ?? { page_path: sent.page_path, kind: sent.kind, revision: 0, payload: sent.kind === 'marks' ? [] : { v: 1, strokes: [] } };
              receiveRow(draft, remote);
              if (local.dirty && !local.conflict) local.conflict = clone(remote);
            }
          }
        });
      }
      if (!current()) return;
      syncState.lastSynced = new Date().toLocaleTimeString();
    } catch (error) {
      if (current()) syncState.error = errorText(error);
    } finally {
      if (current()) { syncState.busy = false; operation = null; publish(); }
    }
  };
  operation = work();
  return operation;
}
export async function resolveConflict(path: string, kind: Kind, choice: 'cloud' | 'local') {
  await update((draft) => resolveSnapshot(draft, path, kind, choice));
  schedule();
}
export function exportAccountBackup() {
  if (!syncState.userId) return;
  const raw = localStorage.getItem(accountKey(syncState.userId));
  download(raw ?? JSON.stringify(store), 'notes-account-backup.json');
}
export function exportConflict(entry: Entry) {
  download(JSON.stringify({ page: entry.page_path, kind: entry.kind, local: entry.payload, cloud: entry.conflict?.payload }, null, 2), 'notes-conflict-backup.json');
}
function download(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function legacyCount() {
  let count = localStorage.getItem(STORAGE_KEY) ? 1 : 0;
  for (let index = 0; index < localStorage.length; index++) if (localStorage.key(index)?.startsWith('os-ink:/')) count++;
  return count;
}
async function importEntries(entries: Array<{ page_path: string; kind: Kind; payload: any }>) {
  const checked = entries.map((entry) => ({ ...entry, page_path: canonicalPath(entry.page_path), payload: validatePayload(entry.kind, entry.payload, entry.page_path) }));
  await update((draft) => {
    for (const entry of checked) {
      const previous = draft.entries[snapshotKey(entry.page_path, entry.kind)];
      if (entry.kind === 'marks') {
        editSnapshot(draft, entry.page_path, entry.kind, mergeMarks(previous?.payload ?? [], entry.payload));
      } else if (!previous || same(previous.payload, entry.payload)) {
        editSnapshot(draft, entry.page_path, entry.kind, entry.payload);
      } else {
        throw Error(`章节 ${entry.page_path} 已有不同的手写批注，本次导入未写入任何内容。请先分别导出备份，避免覆盖。`);
      }
    }
  });
  schedule();
}
function markEntries(marks: any[]) {
  return [...new Set(marks.map(mark => mark.path))].map(path => ({
    page_path: path as string, kind: 'marks' as const, payload: marks.filter(mark => mark.path === path),
  }));
}
export async function importLegacy() {
  const entries: Array<{ page_path: string; kind: Kind; payload: any }> = [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const marks = validateBackup(JSON.parse(raw));
    entries.push(...markEntries(marks));
  }
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)!;
    if (key.startsWith('os-ink:/')) entries.push({ page_path: canonicalPath(key.slice('os-ink:'.length)), kind: 'ink', payload: JSON.parse(localStorage.getItem(key)!) });
  }
  await importEntries(entries);
}
export async function importBackup(value: any) {
  if (value?.version === 1 && value.entries && typeof value.userId === 'string') {
    const backup = validateStore(value, value.userId);
    await importEntries(Object.values(backup.entries));
  } else if (value?.version === 1 && Array.isArray(value.marks)) {
    const marks = validateBackup(value);
    await importEntries(markEntries(marks));
  } else if (value?.v === 1 && typeof value.page === 'string') {
    await importEntries([{ page_path: value.page, kind: 'ink', payload: value }]);
  } else throw Error('请选择账号备份、文字标记备份或手写备份文件。');
}
