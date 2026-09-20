<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import { useCartStore } from '@/stores/cart';
import { useSessionStore } from '@/stores/session';
import { useOfflineStore } from '@/stores/offline';
import { formatMoney } from '@/utils/format';
import { db, type OfflineOrderRecord } from '@/db/dexie';
import { genIdempotencyKey } from '@/utils/idempotency';
import PaymentMethodBar from '@/components/PaymentMethodBar.vue';
import AggregatePayPanel from '@/components/AggregatePayPanel.vue';
import { useReceiptPrinter, type ReceiptData } from '@/composables/useReceiptPrinter';
import type { PolledPayment } from '@/composables/useAggregatePayPolling';

const CHECKOUT_POS_ORDER = gql`
  mutation CheckoutPosOrder($payments: [CheckoutPaymentInput!]!) {
    checkoutPosOrder(input: { payments: $payments }) {
      order {
        id
        code
        state
        total
        totalWithTax
        promotionType
        promotionId
        promotionDiscount
        lines {
          id
          productVariant {
            id
            sku
            name
          }
          unitPriceWithTax
          quantity
          linePriceWithTax
        }
      }
      payments {
        id
        amount
        state
        method
      }
    }
  }
`;

interface ReceiptLine {
  name: string;
  sku: string;
  quantity: number;
  unitPriceWithTax: number;
  linePriceWithTax: number;
}
interface ReceiptPayment {
  method: string;
  amount: number;
  state: string;
}
interface Receipt {
  orderCode: string;
  orderState: string;
  totalWithTax: number;
  lines: ReceiptLine[];
  payments: ReceiptPayment[];
  offline: boolean;
  /** 促销信息（结账时从 cart.order 快照保存，用于打印小票） */
  promotionType?: string | null;
  promotionDiscount?: number | null;
}

const router = useRouter();
const cart = useCartStore();
const sessionStore = useSessionStore();
const offlineStore = useOfflineStore();
const { printReceipt } = useReceiptPrinter();

const total = computed(() => cart.totalWithTax);
const isEmpty = computed(() => cart.isEmpty);
const isOnline = computed(() => offlineStore.isOnline);

type Stage = 'select' | 'aggregate' | 'success';
const stage = ref<Stage>('select');
const checkingOut = ref(false);
const receipt = ref<Receipt | null>(null);

function methodLabel(method: string): string {
  switch (method) {
    case 'cash':
      return '现金';
    case 'aggregate':
      return '聚合码';
    default:
      return method;
  }
}

function buildReceipt(order: any, payments: any[], stateOverride?: string, offline = false): Receipt {
  return {
    orderCode: order?.code || '',
    orderState: stateOverride ?? order?.state ?? '',
    totalWithTax: order?.totalWithTax ?? 0,
    lines: (order?.lines ?? []).map((l: any) => ({
      name: l.productVariant?.name ?? '',
      sku: l.productVariant?.sku ?? '',
      quantity: l.quantity ?? 0,
      unitPriceWithTax: l.unitPriceWithTax ?? 0,
      linePriceWithTax: l.linePriceWithTax ?? 0,
    })),
    payments: (payments ?? []).map((p: any) => ({
      method: p.method ?? '',
      amount: p.amount ?? 0,
      state: p.state ?? '',
    })),
    offline,
    promotionType: order?.promotionType ?? null,
    promotionDiscount: order?.promotionDiscount ?? null,
  };
}

/** 离线降级：写入 IndexedDB 队列 + 显示离线小票 */
async function handleOfflineCash() {
  if (checkingOut.value || isEmpty.value) return;
  const order = cart.order;
  if (!order) {
    ElMessage.warning('购物车为空');
    return;
  }
  const session = sessionStore.currentSession;
  const now = new Date().toISOString();
  const idempotencyKey = genIdempotencyKey('order');

  const record: OfflineOrderRecord = {
    idempotencyKey,
    clientCreatedAt: now,
    clientUpdatedAt: now,
    sessionCode: session?.code ?? '',
    terminalCode: session?.terminal?.code ?? '',
    orderType: 'sale',
    lines: cart.lines.map((l) => ({
      productVariantId: l.productVariant.id,
      quantity: l.quantity,
      discount: l.customFields.discount || undefined,
      isGift: l.customFields.isGift || undefined,
      note: l.customFields.note ?? undefined,
      originalPrice: l.customFields.originalPrice || undefined,
    })),
    payments: [{ method: 'cash' }],
    totalAmount: cart.totalWithTax,
    syncStatus: 'pending',
  };

  try {
    await db.orders.put(record);
    await db.payments.put({
      idempotencyKey: genIdempotencyKey('payment'),
      clientCreatedAt: now,
      clientUpdatedAt: now,
      orderKey: idempotencyKey,
      method: 'cash',
      amount: cart.totalWithTax,
      syncStatus: 'pending',
    });
    receipt.value = buildReceipt(order, [{ method: 'cash', amount: cart.totalWithTax }], '离线已保存', true);
    cart.clear();
    stage.value = 'success';
    ElMessage.success('已离线保存，联网后自动同步');
    await offlineStore.updateCounts();
  } catch (e) {
    ElMessage.error('离线保存失败：' + (e instanceof Error ? e.message : ''));
  }
}

async function handleCash() {
  if (checkingOut.value || isEmpty.value) return;
  if (!isOnline.value) {
    await handleOfflineCash();
    return;
  }
  checkingOut.value = true;
  try {
    const { data, errors } = await apolloClient.mutate({
      mutation: CHECKOUT_POS_ORDER,
      variables: { payments: [{ method: 'cash' }] },
    });
    if (errors?.length) throw new Error(errors[0].message);
    const result = data?.checkoutPosOrder;
    if (!result) throw new Error('结账失败：无响应');
    receipt.value = buildReceipt(result.order, result.payments);
    cart.clear();
    stage.value = 'success';
  } catch (e) {
    ElMessage.error('结账失败：' + (e instanceof Error ? e.message : ''));
  } finally {
    checkingOut.value = false;
  }
}

function handleAggregate() {
  if (isEmpty.value) return;
  if (!isOnline.value) {
    ElMessage.warning('离线模式不支持聚合支付，请使用现金');
    return;
  }
  stage.value = 'aggregate';
}

function handleAggregateSuccess(payment: PolledPayment) {
  // 聚合码已由轮询自动 settle，Order 已到 PaymentSettled，后端 activeOrderId 已清空。
  // 用 cart store 中的订单快照构建小票。
  const order = cart.order;
  receipt.value = buildReceipt(order, [payment], 'PaymentSettled');
  cart.clear();
  stage.value = 'success';
}

function handleAggregateFail(_reason: string) {
  // 返回支付方式选择（购物车保留，Order 已退回 AddingItems）
  stage.value = 'select';
}

function handleNewOrder() {
  router.push('/cashier');
}

function handleBackToCashier() {
  router.push('/cashier');
}

/** 打印小票：将当前 receipt 转为 ReceiptData 调用打印机 */
function handlePrint() {
  if (!receipt.value) return;
  const data: ReceiptData = {
    ...receipt.value,
    terminalCode: sessionStore.currentSession?.terminal?.code,
    sessionCode: sessionStore.currentSession?.code,
    createdAt: new Date().toISOString(),
  };
  const ok = printReceipt(data);
  if (!ok) {
    ElMessage.warning('打印窗口被浏览器拦截，请允许弹窗后重试');
  }
}
</script>

<template>
  <div class="checkout-view">
    <!-- 顶部：返回收银台 + 网络状态 -->
    <header class="top-bar">
      <el-button text @click="handleBackToCashier">← 返回收银台</el-button>
      <span class="title">结账</span>
      <span class="net-badge" :class="isOnline ? 'online' : 'offline'">
        {{ isOnline ? '● 在线' : '● 离线' }}
      </span>
    </header>

    <main class="content">
      <!-- 阶段一：选择支付方式 -->
      <template v-if="stage === 'select'">
        <div class="amount-section">
          <div class="amount-label">应收金额</div>
          <div class="amount-value">¥{{ formatMoney(total) }}</div>
        </div>
        <div class="method-section">
          <PaymentMethodBar @cash="handleCash" @aggregate="handleAggregate" />
        </div>
        <div class="hint" v-if="isEmpty">购物车为空，请先返回收银台添加商品</div>
        <div class="hint offline-hint" v-else-if="!isOnline">
          离线模式：现金结账将本地保存，联网后自动同步
        </div>
      </template>

      <!-- 阶段二：聚合码支付 -->
      <template v-else-if="stage === 'aggregate'">
        <div class="amount-section">
          <div class="amount-label">应收金额</div>
          <div class="amount-value">¥{{ formatMoney(total) }}</div>
        </div>
        <AggregatePayPanel
          @success="handleAggregateSuccess"
          @fail="handleAggregateFail"
        />
      </template>

      <!-- 阶段三：支付成功 + 小票预览 -->
      <template v-else>
        <div class="success-section">
          <div class="success-icon" :class="{ offline: receipt?.offline }">
            {{ receipt?.offline ? '⇩' : '✓' }}
          </div>
          <h2>{{ receipt?.offline ? '已离线保存' : '支付成功' }}</h2>
          <div class="offline-tip" v-if="receipt?.offline">联网后自动同步到服务器</div>
        </div>
        <div class="receipt" v-if="receipt">
          <div class="receipt-header">
            <span>订单号：{{ receipt.orderCode || (receipt.offline ? '离线订单' : '-') }}</span>
            <el-tag v-if="receipt.offline" type="warning" size="small">离线</el-tag>
          </div>
          <div class="receipt-lines">
            <div v-for="(line, idx) in receipt.lines" :key="idx" class="receipt-line">
              <div class="line-name">{{ line.name }}</div>
              <div class="line-qty">×{{ line.quantity }}</div>
              <div class="line-price">¥{{ formatMoney(line.linePriceWithTax) }}</div>
            </div>
          </div>
          <el-divider />
          <div class="receipt-total">
            <span>合计</span>
            <span class="total-num">¥{{ formatMoney(receipt.totalWithTax) }}</span>
          </div>
          <div class="receipt-payments">
            <div
              v-for="(pay, idx) in receipt.payments"
              :key="idx"
              class="payment-row"
            >
              <span>{{ methodLabel(pay.method) }}</span>
              <span>¥{{ formatMoney(pay.amount) }}</span>
            </div>
          </div>
        </div>
        <div class="success-actions">
          <el-button size="large" @click="handlePrint">
            打印小票
          </el-button>
          <el-button type="primary" size="large" @click="handleNewOrder">
            新订单
          </el-button>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.checkout-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f0f2f5;
  overflow: hidden;
}
.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  background: #fff;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
}
.top-bar .title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}
.net-badge {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 10px;
  font-weight: 500;
}
.net-badge.online {
  color: #67c23a;
  background: #f0f9eb;
}
.net-badge.offline {
  color: #f56c6c;
  background: #fef0f0;
}
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: 32px 16px;
  overflow-y: auto;
  gap: 24px;
}
.amount-section {
  text-align: center;
}
.amount-label {
  font-size: 14px;
  color: #909399;
}
.amount-value {
  font-size: 48px;
  font-weight: 700;
  color: #f56c6c;
  margin-top: 8px;
}
.method-section {
  margin-top: 16px;
}
.hint {
  color: #909399;
  font-size: 13px;
}
.offline-hint {
  color: #e6a23c;
}
.success-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.success-icon {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: #67c23a;
  color: #fff;
  font-size: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.success-icon.offline {
  background: #e6a23c;
}
.success-section h2 {
  margin: 0;
  color: #303133;
}
.offline-tip {
  font-size: 13px;
  color: #909399;
}
.receipt {
  width: 100%;
  max-width: 480px;
  background: #fff;
  border-radius: 8px;
  padding: 16px 20px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}
.receipt-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: #909399;
  margin-bottom: 12px;
}
.receipt-line {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 12px;
  padding: 6px 0;
  font-size: 14px;
  color: #303133;
}
.line-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.line-qty {
  color: #909399;
}
.line-price {
  text-align: right;
  min-width: 70px;
}
.receipt-total {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 16px;
  color: #303133;
}
.total-num {
  font-size: 22px;
  font-weight: 700;
  color: #f56c6c;
}
.receipt-payments {
  margin-top: 8px;
}
.payment-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
  color: #606266;
}
.success-actions {
  margin-top: 8px;
  display: flex;
  gap: 12px;
}
</style>
