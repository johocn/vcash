<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';

const HELD_ORDERS = gql`
  query HeldOrders {
    heldOrders {
      id
      code
      state
      total
      totalWithTax
      updatedAt
      lines {
        id
        productVariant {
          id
          sku
          name
        }
        quantity
        unitPriceWithTax
      }
    }
  }
`;

interface HeldOrderLine {
  id: string;
  productVariant: { id: string; sku: string; name: string };
  quantity: number;
  unitPriceWithTax: number;
}
interface HeldOrder {
  id: string;
  code: string;
  state: string;
  total: number;
  totalWithTax: number;
  updatedAt: string;
  lines: HeldOrderLine[];
}

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'resume', orderId: string): void;
}>();

const loading = ref(false);
const orders = ref<HeldOrder[]>([]);

function buildSummary(order: HeldOrder): string {
  const lines = order.lines ?? [];
  if (lines.length === 0) return '无商品';
  const first = lines[0];
  const head = `${first.productVariant.name} × ${first.quantity}`;
  if (lines.length === 1) return head;
  return `${head} 等 ${lines.length} 件`;
}

async function loadHeldOrders() {
  loading.value = true;
  try {
    const { data, errors } = await apolloClient.query({
      query: HELD_ORDERS,
      fetchPolicy: 'network-only',
    });
    if (errors?.length) throw new Error(errors[0].message);
    orders.value = (data?.heldOrders as HeldOrder[] | undefined) ?? [];
  } catch (e) {
    ElMessage.error('加载挂单失败：' + (e instanceof Error ? e.message : ''));
    orders.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) loadHeldOrders();
  },
);

function handleDialogUpdate(v: boolean) {
  emit('update:visible', v);
}

function handleResume(order: HeldOrder) {
  emit('resume', order.id);
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="挂单列表"
    width="600px"
    @update:model-value="handleDialogUpdate"
  >
    <div v-loading="loading" class="held-orders">
      <!-- 空状态 -->
      <div v-if="!loading && orders.length === 0" class="empty-state">
        暂无挂单
      </div>

      <!-- 列表 -->
      <ul v-else class="order-list">
        <li
          v-for="order in orders"
          :key="order.id"
          class="order-row"
          @click="handleResume(order)"
        >
          <div class="order-code">{{ order.code }}</div>
          <div class="order-summary">{{ buildSummary(order) }}</div>
          <div class="order-time">
            {{ new Date(order.updatedAt).toLocaleString('zh-CN') }}
          </div>
        </li>
      </ul>
    </div>
  </el-dialog>
</template>

<style scoped>
.held-orders {
  min-height: 120px;
}
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 0;
  color: #909399;
  font-size: 14px;
}
.order-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.order-row {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  grid-template-areas:
    'code time'
    'summary summary';
  gap: 4px 12px;
  padding: 12px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  transition: background-color 0.15s;
}
.order-row:hover {
  background: #f5f7fa;
}
.order-code {
  grid-area: code;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}
.order-time {
  grid-area: time;
  font-size: 12px;
  color: #909399;
  white-space: nowrap;
}
.order-summary {
  grid-area: summary;
  font-size: 13px;
  color: #606266;
}
</style>
