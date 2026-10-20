import { validateBackup } from '../../../.vitepress/theme/annotations/model.mjs';

export function canonicalPath(value) {
  const path = String(value).split(/[?#]/)[0].replace(/\.html\/?$/, '').replace(/\/$/, '');
  const match = path.match(/(?:^|\/)(notes|foundations)\/([a-z0-9-]+)$/);
  if (!match || path.includes('..')) throw Error('无法识别批注所属章节。');
  return `/${match[1]}/${match[2]}`;
}
export const accountKey = (userId) => `os-cloud-v1:${encodeURIComponent(userId)}`;
export const snapshotKey = (path, kind) => `${kind}:${canonicalPath(path)}`;
export const clone = (value) => JSON.parse(JSON.stringify(value));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const emptyStore = (userId) => ({ version: 1, userId, entries: {} });

export function validatePayload(kind, value, path) {
  path = canonicalPath(path);
  if (kind === 'marks') {
    const marks = validateBackup({ version: 1, marks: value });
    if (marks.some((mark) => mark.path !== path)) throw Error('标记所属章节不匹配。');
    return marks;
  }
  if (kind !== 'ink' || !value || value.v !== 1 || !Array.isArray(value.strokes) || value.strokes.length > 20000)
    throw Error('手写备份格式不正确。');
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  for (const stroke of value.strokes) {
    if (!stroke || !['pen', 'hl'].includes(stroke.t) || typeof stroke.c !== 'string' || !/^#[\da-f]{6}$/i.test(stroke.c)
      || !finite(stroke.s) || stroke.s <= 0 || stroke.s > 100 || !Array.isArray(stroke.pts) || stroke.pts.length > 100000
      || stroke.pts.some((point) => !Array.isArray(point) || point.length !== 3 || !point.every(finite)))
      throw Error('手写备份包含无效笔画。');
  }
  for (const field of ['vw', 'fs'])
    if (value[field] !== undefined && (!finite(value[field]) || value[field] <= 0)) throw Error('手写尺寸无效。');
  return clone({ v: 1, ...(value.vw ? { vw: value.vw } : {}), ...(value.fs ? { fs: value.fs } : {}), strokes: value.strokes });
}
export function normalizeRow(row) {
  if (!row || !Number.isSafeInteger(row.revision) || row.revision < 0) throw Error('云端批注版本无效。');
  const page_path = canonicalPath(row.page_path);
  return { page_path, kind: row.kind, revision: row.revision, payload: validatePayload(row.kind, row.payload, page_path) };
}
export function validateStore(value, userId) {
  if (!value || value.version !== 1 || value.userId !== userId || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries))
    throw Error('无法读取此账号的本地批注，请先导出原始备份。');
  const result = emptyStore(userId);
  for (const [key, item] of Object.entries(value.entries)) {
    const row = normalizeRow(item);
    if (key !== snapshotKey(row.page_path, row.kind) || typeof item.dirty !== 'boolean' || !Number.isSafeInteger(item.localVersion) || item.localVersion < 0)
      throw Error('本地批注记录无效。');
    const conflict = item.conflict ? { ...normalizeRow(item.conflict), pending: item.conflict.pending === true } : null;
    if (conflict && (conflict.kind !== row.kind || conflict.page_path !== row.page_path)) throw Error('冲突记录所属章节不匹配。');
    result.entries[key] = { ...row, dirty: item.dirty, localVersion: item.localVersion, conflict };
  }
  return result;
}
export function editSnapshot(store, path, kind, payload) {
  const page_path = canonicalPath(path), key = snapshotKey(page_path, kind);
  const checked = validatePayload(kind, payload, page_path), previous = store.entries[key];
  if (previous && same(previous.payload, checked)) return false;
  store.entries[key] = {
    page_path, kind, payload: checked, revision: previous?.revision ?? 0,
    dirty: true, localVersion: (previous?.localVersion ?? 0) + 1, conflict: previous?.conflict ?? null,
  };
  return true;
}
export function editWithBaseline(store, path, kind, payload, baseline) {
  const key = snapshotKey(path, kind), previous = store.entries[key];
  const concurrent = previous && baseline && !same(previous.payload, baseline) && !same(previous.payload, payload)
    ? { page_path: previous.page_path, kind: previous.kind, revision: previous.revision, payload: clone(previous.payload), pending: previous.dirty } : null;
  editSnapshot(store, path, kind, payload);
  if (concurrent && !store.entries[key].conflict) store.entries[key].conflict = concurrent;
}
export function receiveRow(store, input) {
  const row = normalizeRow(input), key = snapshotKey(row.page_path, row.kind), local = store.entries[key];
  if (local && (row.revision < local.revision || local.conflict)) return;
  if (local?.dirty) {
    if (same(local.payload, row.payload)) {
      local.revision = row.revision;
      local.dirty = false;
      local.conflict = null;
    } else if (row.revision !== local.revision) {
      local.conflict = row;
    }
    return;
  }
  store.entries[key] = { ...row, dirty: false, localVersion: local?.localVersion ?? 0, conflict: null };
}
export function acknowledge(store, sent, input) {
  const row = normalizeRow(input), key = snapshotKey(row.page_path, row.kind), local = store.entries[key];
  if (!local || row.revision < local.revision || local.conflict) return;
  local.revision = row.revision;
  local.conflict = null;
  local.dirty = local.localVersion !== sent.localVersion || !same(local.payload, sent.payload);
  if (!local.dirty) local.payload = row.payload;
}
export function resolveSnapshot(store, path, kind, choice) {
  const local = store.entries[snapshotKey(path, kind)];
  if (!local?.conflict || !['cloud', 'local'].includes(choice)) return;
  local.revision = local.conflict.revision;
  if (choice === 'cloud') local.payload = clone(local.conflict.payload);
  local.dirty = choice === 'local' || local.conflict.pending === true;
  local.localVersion += 1;
  local.conflict = null;
}

// Read and write happen inside one same-origin lock; no network is awaited here.
export async function lockedMutation(locks, key, isCurrent, read, write, change) {
  if (!locks?.request) throw Error('此浏览器不支持安全的多标签页保存，请使用支持 Web Locks 的新版浏览器。');
  return locks.request(key, { mode: 'exclusive' }, () => {
    if (!isCurrent()) throw Error('登录账号已变化，本次操作未写入其他账号。');
    const draft = read();
    change(draft);
    write(draft);
    return draft;
  });
}
