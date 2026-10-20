<script setup lang="ts">
import { ref } from 'vue';
import { syncState, flushSync, resolveConflict, exportConflict } from '../backend/sync';
const props = defineProps<{ pages: { path: string; title: string }[] }>();
const message = ref('');
async function choose(entry: any, choice: 'cloud' | 'local') {
  try { await resolveConflict(entry.page_path, entry.kind, choice); message.value = ''; }
  catch (error) { message.value = (error as Error).message; }
}
function count(payload: any, kind: string) { return kind === 'marks' ? `${payload?.length ?? 0} 条文字标记` : `${payload?.strokes?.length ?? 0} 条笔画`; }
</script>

<template>
  <section v-if="syncState.error || syncState.conflicts.length" class="sync-panel" aria-label="批注保存提示">
    <template v-if="syncState.error">
      <p role="alert">{{ syncState.error }}</p>
      <button type="button" :disabled="syncState.busy" @click="flushSync">重试同步</button>
    </template>
    <div v-for="entry in syncState.conflicts" :key="`${entry.kind}:${entry.page_path}`" class="sync-conflict">
      <p><strong>{{ props.pages.find(page => page.path === entry.page_path)?.title || entry.page_path }}</strong></p>
      <p role="status">这篇笔记有两份不同的批注，已分别保留。请选择要继续使用的版本。</p>
      <p>此设备：{{ count(entry.payload, entry.kind) }}；{{ entry.conflict.pending ? '另一份待上传记录' : '云端' }}：{{ count(entry.conflict.payload, entry.kind) }}</p>
      <div class="sync-actions">
        <button type="button" @click="exportConflict(entry)">导出两份备份</button>
        <button type="button" @click="choose(entry, 'local')">使用此设备版本</button>
        <button type="button" @click="choose(entry, 'cloud')">{{ entry.conflict.pending ? '使用另一份待上传记录' : '使用云端版本' }}</button>
      </div>
    </div>
    <p v-if="message" role="alert">{{ message }}</p>
  </section>
</template>
