import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPath, accountKey, emptyStore, lockedMutation, editSnapshot, editWithBaseline, receiveRow, acknowledge, resolveSnapshot, snapshotKey, validatePayload, validateStore } from '../app/src/backend/sync-model.mjs';
const path = '/notes/lec06-sockets-pipes';
const ink = (x = 1) => ({ v: 1, vw: 1000, fs: 17, strokes: [{ c: '#1a1a1a', s: 5, t: 'pen', pts: [[x, 2, 0.5], [3, 4, 0.5]] }] });
const row = (revision, payload = ink()) => ({ page_path: path, kind: 'ink', revision, payload });

test('canonical paths are independent of hosting base, suffix, query and hash', () => {
  assert.equal(canonicalPath('/os-csc3150-notes/notes/lec06-sockets-pipes.html#intro'), path);
  assert.equal(canonicalPath('/notes/lec06-sockets-pipes/?a=1'), path);
  assert.throws(() => canonicalPath('/unrelated/page'));
  assert.throws(() => canonicalPath('/notes/../secrets'));
  assert.notEqual(accountKey('user-a'), accountKey('user-b'));
});
test('deleting the last marks remains a durable dirty snapshot', () => {
  const store = emptyStore('user-a');
  editSnapshot(store, path, 'marks', []);
  const saved = JSON.parse(JSON.stringify(store));
  assert.equal(saved.entries[snapshotKey(path, 'marks')].dirty, true);
  assert.deepEqual(saved.entries[snapshotKey(path, 'marks')].payload, []);
  assert.equal(saved.entries[snapshotKey(path, 'marks')].revision, 0);
});
test('remote changes never overwrite a dirty local snapshot', () => {
  const store = emptyStore('user-a');
  receiveRow(store, row(2));
  editSnapshot(store, path, 'ink', ink(9));
  receiveRow(store, row(3, ink(7)));
  const item = store.entries[snapshotKey(path, 'ink')];
  assert.deepEqual(item.payload, ink(9));
  assert.deepEqual(item.conflict.payload, ink(7));
  assert.equal(item.dirty, true);
  resolveSnapshot(store, path, 'ink', 'local');
  assert.equal(item.revision, 3);
  assert.equal(item.dirty, true);
  assert.equal(item.conflict, null);
});
test('explicit cloud choice replaces local pending copy', () => {
  const store = emptyStore('user-a');
  editSnapshot(store, path, 'ink', ink(9));
  receiveRow(store, row(1));
  resolveSnapshot(store, path, 'ink', 'cloud');
  const item = store.entries[snapshotKey(path, 'ink')];
  assert.deepEqual(item.payload, ink());
  assert.equal(item.dirty, false);
});
test('acknowledgment cannot discard edits made during an in-flight save', () => {
  const store = emptyStore('user-a');
  editSnapshot(store, path, 'ink', ink());
  const sent = structuredClone(store.entries[snapshotKey(path, 'ink')]);
  editSnapshot(store, path, 'ink', ink(9));
  acknowledge(store, sent, row(1));
  const item = store.entries[snapshotKey(path, 'ink')];
  assert.equal(item.dirty, true);
  assert.deepEqual(item.payload, ink(9));
  assert.equal(item.revision, 1);
});
test('matching server snapshot recovers acknowledgment lost on disconnect', () => {
  const store = emptyStore('user-a');
  editSnapshot(store, path, 'ink', ink());
  receiveRow(store, row(1));
  const item = store.entries[snapshotKey(path, 'ink')];
  assert.equal(item.dirty, false);
  assert.equal(item.revision, 1);
});
test('malformed imported handwriting and marks are rejected before replacing data', () => {
  assert.throws(() => validatePayload('ink', { ...ink(), strokes: [{ t: 'pen', pts: [[Infinity, 0, 1]] }] }, path));
  assert.throws(() => validatePayload('marks', [{ id: 'broken' }], path));
  assert.deepEqual(validatePayload('ink', ink(), path), ink());
});

test('account envelopes reject another user and retain outbox plus conflict after reload', () => {
  const store = emptyStore('user-a');
  editSnapshot(store, path, 'ink', ink(9));
  receiveRow(store, row(1));
  assert.throws(() => validateStore(store, 'user-b'));
  const reloaded = validateStore(JSON.parse(JSON.stringify(store)), 'user-a');
  assert.equal(reloaded.entries[snapshotKey(path, 'ink')].dirty, true);
  assert.deepEqual(reloaded.entries[snapshotKey(path, 'ink')].payload, ink(9));
  assert.deepEqual(reloaded.entries[snapshotKey(path, 'ink')].conflict.payload, ink());
});
test('stale pull responses cannot roll back a newer local server revision', () => {
  const store = emptyStore('user-a');
  receiveRow(store, row(3, ink(3)));
  receiveRow(store, row(2, ink(2)));
  assert.equal(store.entries[snapshotKey(path, 'ink')].revision, 3);
  assert.deepEqual(store.entries[snapshotKey(path, 'ink')].payload, ink(3));
});
test('an acknowledged save cannot erase a different tab edit with the same local counter', () => {
  const store = emptyStore('user-a');
  editSnapshot(store, path, 'ink', ink(9));
  const sent = { ...structuredClone(store.entries[snapshotKey(path, 'ink')]), payload: ink(1) };
  acknowledge(store, sent, row(1, ink(1)));
  assert.equal(store.entries[snapshotKey(path, 'ink')].dirty, true);
  assert.deepEqual(store.entries[snapshotKey(path, 'ink')].payload, ink(9));
});

test('drawing started before a remote update retains both versions instead of replacing it', () => {
  const store = emptyStore('user-a');
  receiveRow(store, row(1, ink(1)));
  const baseline = ink(1);
  receiveRow(store, row(2, ink(2)));
  editWithBaseline(store, path, 'ink', ink(3), baseline);
  const item = store.entries[snapshotKey(path, 'ink')];
  assert.deepEqual(item.payload, ink(3));
  assert.deepEqual(item.conflict.payload, ink(2));
  assert.equal(item.dirty, true);
});
test('pending local alternative survives refresh and remains dirty when explicitly chosen', () => {
  const store = emptyStore('user-a');
  receiveRow(store, row(1, ink(1)));
  editSnapshot(store, path, 'ink', ink(2));
  editWithBaseline(store, path, 'ink', ink(3), ink(1));
  receiveRow(store, row(2, ink(3)));
  const item = store.entries[snapshotKey(path, 'ink')];
  assert.equal(item.conflict.pending, true);
  assert.deepEqual(item.conflict.payload, ink(2));
  resolveSnapshot(store, path, 'ink', 'cloud');
  assert.equal(item.dirty, true);
  assert.deepEqual(item.payload, ink(2));
});

test('later responses preserve an unresolved conflict until explicit choice', () => {
  const store = emptyStore('user-a');
  editSnapshot(store, path, 'ink', ink(1));
  const sent = structuredClone(store.entries[snapshotKey(path, 'ink')]);
  receiveRow(store, row(1, ink(2)));
  receiveRow(store, row(2, ink(1)));
  acknowledge(store, sent, row(2, ink(1)));
  const item = store.entries[snapshotKey(path, 'ink')];
  assert.equal(item.dirty, true);
  assert.deepEqual(item.payload, ink(1));
  assert.deepEqual(item.conflict.payload, ink(2));
});

function serialLocks() {
  let tail = Promise.resolve();
  return { request(_key, _options, callback) {
    if (typeof _options === 'function') callback = _options;
    const result = tail.then(callback);
    tail = result.catch(() => {});
    return result;
  } };
}
test('two tabs read and mutate the latest envelope only after obtaining the exclusive lock', async () => {
  const locks = serialLocks();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const blocker = locks.request('account', {}, () => gate);
  let disk = emptyStore('user-a'), reads = 0;
  const read = () => { reads++; return structuredClone(disk); };
  const write = value => { disk = structuredClone(value); };
  const first = lockedMutation(locks, 'account', () => true, read, write,
    draft => editSnapshot(draft, path, 'ink', ink(1)));
  const second = lockedMutation(locks, 'account', () => true, read, write,
    draft => editSnapshot(draft, '/notes/lec05-files', 'ink', ink(2)));
  assert.equal(reads, 0);
  release();
  await Promise.all([blocker, first, second]);
  assert.equal(reads, 2);
  assert.deepEqual(disk.entries[snapshotKey(path, 'ink')].payload, ink(1));
  assert.deepEqual(disk.entries[snapshotKey('/notes/lec05-files', 'ink')].payload, ink(2));
});
test('a queued mutation cannot write after logout or account switch', async () => {
  const locks = serialLocks();
  let release, current = true, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const blocker = locks.request('account', {}, () => gate);
  const mutation = lockedMutation(locks, 'account', () => current, () => emptyStore('user-a'),
    () => { writes++; }, draft => editSnapshot(draft, path, 'ink', ink()));
  current = false;
  release();
  await blocker;
  await assert.rejects(mutation, /登录账号已变化/);
  assert.equal(writes, 0);
});
test('save uses the note editor baseline, preserving a remote change made while the editor stays open', () => {
  const mark = { id: 'mark-a', path, updated: 1, start: 0, quote: 'hello', prefix: '', suffix: '', section: 'intro', heading: 'Intro', note: 'original' };
  const store = emptyStore('user-a');
  receiveRow(store, { page_path: path, kind: 'marks', revision: 1, payload: [mark] });
  const editorBaseline = structuredClone(store.entries[snapshotKey(path, 'marks')].payload);
  const remote = { ...mark, note: 'saved on device B', updated: 2 };
  receiveRow(store, { page_path: path, kind: 'marks', revision: 2, payload: [remote] });
  editWithBaseline(store, path, 'marks', [{ ...mark, note: 'draft on device A', updated: 3 }], editorBaseline);
  const item = store.entries[snapshotKey(path, 'marks')];
  assert.equal(item.payload[0].note, 'draft on device A');
  assert.equal(item.conflict.payload[0].note, 'saved on device B');
  assert.equal(item.dirty, true);
});
