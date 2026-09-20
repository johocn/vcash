<script setup lang="ts">
import { onMounted } from 'vue';
import { useOfflineStore } from '@/stores/offline';
import { useOfflineSync } from '@/composables/useOfflineSync';
import { useIncrementalSync } from '@/composables/useIncrementalSync';

// 启动时初始化离线模块：网络检测 + 队列调度 + 增量同步
const offlineStore = useOfflineStore();
useOfflineSync();
useIncrementalSync();

onMounted(() => {
  offlineStore.detectNetwork();
  offlineStore.updateCounts();
});
</script>

<template>
  <router-view />
</template>
