<script setup lang="ts">
export interface Category {
  id: string;
  name: string;
  slug: string;
  preview?: string | null;
}

defineProps<{
  categories: Category[];
  modelValue: string; // '' 表示全部，否则为 collectionId
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();
</script>

<template>
  <div class="category-bar">
    <el-tabs
      :model-value="modelValue"
      @update:model-value="emit('update:modelValue', String($event ?? ''))"
    >
      <el-tab-pane label="全部" name="">
        <template #label>
          <span class="tab-label">全部</span>
        </template>
      </el-tab-pane>
      <el-tab-pane
        v-for="c in categories"
        :key="c.id"
        :label="c.name"
        :name="c.id"
      >
        <template #label>
          <span class="tab-label" :title="c.name">{{ c.name }}</span>
        </template>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.category-bar {
  background: #fff;
  border-bottom: 1px solid #ebeef5;
  padding: 0 12px;
}
.category-bar :deep(.el-tabs__header) {
  margin: 0;
}
.category-bar :deep(.el-tabs__nav-wrap)::after {
  display: none;
}
.category-bar :deep(.el-tabs__nav) {
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  max-width: 100%;
}
.category-bar :deep(.el-tabs__nav::-webkit-scrollbar) {
  height: 4px;
}
.category-bar :deep(.el-tabs__nav::-webkit-scrollbar-thumb) {
  background: #dcdfe6;
  border-radius: 2px;
}
.tab-label {
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: inline-block;
  vertical-align: bottom;
}
</style>
