<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';

/**
 * 统一商品卡片数据结构：
 * - 来自 products query 的 Product（取第一个 variant 作为默认加购项）
 * - 来自 collection.productVariants query 的 ProductVariant（productId/productName 来自 product 字段）
 */
export interface ProductCard {
  productId: string;
  variantId: string;
  name: string;
  sku: string;
  price: number;
  priceWithTax: number;
  preview?: string | null;
}

const props = defineProps<{
  items: ProductCard[];
  loading?: boolean;
  hasMore?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select', card: ProductCard): void;
  (e: 'load-more'): void;
}>();

const gridRef = ref<HTMLElement | null>(null);
const loadingMore = ref(false);

function handleScroll() {
  const el = gridRef.value;
  if (!el || loadingMore.value) return;
  const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
  if (nearBottom && props.hasMore) {
    loadingMore.value = true;
    emit('load-more');
  }
}

watch(
  () => props.loading,
  (v) => {
    if (!v) loadingMore.value = false;
  },
);

onMounted(() => {
  nextTick(() => {
    gridRef.value?.addEventListener('scroll', handleScroll, { passive: true });
  });
});
onUnmounted(() => {
  gridRef.value?.removeEventListener('scroll', handleScroll);
});
</script>

<template>
  <div class="product-grid-wrapper" ref="gridRef" v-loading="loading && items.length === 0">
    <div v-if="items.length === 0 && !loading" class="empty-tip">暂无商品</div>
    <div class="grid">
      <div
        v-for="item in items"
        :key="item.variantId"
        class="card"
        @click="emit('select', item)"
      >
        <div class="thumb">
          <img v-if="item.preview" :src="item.preview" :alt="item.name" loading="lazy" />
          <div v-else class="thumb-placeholder">无图</div>
        </div>
        <div class="info">
          <div class="name" :title="item.name">{{ item.name }}</div>
          <div class="sku" :title="item.sku">SKU: {{ item.sku || '-' }}</div>
          <div class="price">¥{{ ((item.priceWithTax ?? item.price) / 100).toFixed(2) }}</div>
        </div>
      </div>
    </div>
    <div v-if="hasMore && items.length > 0" class="load-more-tip">
      <span v-if="loadingMore">加载中...</span>
      <span v-else>滚动加载更多</span>
    </div>
  </div>
</template>

<style scoped>
.product-grid-wrapper {
  height: 100%;
  overflow-y: auto;
  padding: 12px;
  box-sizing: border-box;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}
.card {
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.15s;
}
.card:hover {
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}
.thumb {
  width: 100%;
  aspect-ratio: 1 / 1;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb-placeholder {
  color: #c0c4cc;
  font-size: 12px;
}
.info {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.name {
  font-size: 13px;
  font-weight: 500;
  color: #303133;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sku {
  font-size: 11px;
  color: #909399;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.price {
  font-size: 15px;
  color: #f56c6c;
  font-weight: 600;
  margin-top: 2px;
}
.empty-tip {
  text-align: center;
  color: #909399;
  padding: 60px 0;
}
.load-more-tip {
  text-align: center;
  color: #909399;
  padding: 12px 0;
  font-size: 12px;
}
</style>
