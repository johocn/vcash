<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import { formatMoney } from '@/utils/format';

const POS_ORDER_BY_CODE = gql`
  query PosOrderByCode($code: String!) {
    posOrderByCode(code: $code) {
      id
      code
      state
      total
      totalWithTax
      createdAt
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
        customFields {
          originalPrice
          discount
          memberPriceApplied
          isGift
          note
        }
      }
      payments {
        id
        amount
        method
        state
      }
    }
  }
`;

const CREATE_REFUND_ORDER = gql`
  mutation CreateRefundOrder(
    $originalOrderId: ID!
    $refundLines: [RefundLineInput!]!
  ) {
    createRefundOrder(
      input: { originalOrderId: $originalOrderId, refundLines: $refundLines }
    ) {
      refundOrder {
        id
        code
        state
        total
        totalWithTax
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
        payments {
          id
          amount
          method
          state
        }
      }
      originalOrder {
        id
        code
      }
    }
  }
`;

interface OriginalLine {
  id: string;
  productVariant: { id: string; sku: string; name: string };
  unitPriceWithTax: number;
  quantity: number;
  linePriceWithTax: number;
  customFields: {
    originalPrice: number;
    discount: number;
    memberPriceApplied: boolean;
    isGift: boolean;
    note: string | null;
  };
}
interface OriginalOrder {
  id: string;
  code: string;
  state: string;
  total: number;
  totalWithTax: number;
  createdAt: string;
  lines: OriginalLine[];
  payments: Array<{ id: string; amount: number; method: string; state: string }>;
}

const router = useRouter();

const codeInput = ref('');
const searching = ref(false);
const originalOrder = ref<OriginalOrder | null>(null);
const refundQtys = ref<Record<string, number>>({});
const refundReason = ref('');
const submitting = ref(false);

const refundTotal = computed(() => {
  if (!originalOrder.value) return 0;
  return originalOrder.value.lines.reduce((sum, line) => {
    const qty = refundQtys.value[line.id] ?? 0;
    if (qty <= 0) return sum;
    const unitPrice = line.unitPriceWithTax;
    return sum + Math.round(unitPrice * qty);
  }, 0);
});

const hasRefundSelection = computed(() => {
  return Object.values(refundQtys.value).some(q => q > 0);
});

async function handleSearch() {
  const code = codeInput.value.trim();
  if (!code) {
    ElMessage.warning('请输入原单号');
    return;
  }
  searching.value = true;
  originalOrder.value = null;
  refundQtys.value = {};
  try {
    const { data, errors } = await apolloClient.query({
      query: POS_ORDER_BY_CODE,
      variables: { code },
      fetchPolicy: 'network-only',
    });
    if (errors?.length) throw new Error(errors[0].message);
    const order = data?.posOrderByCode;
    if (!order) {
      ElMessage.error('未找到该订单');
      return;
    }
    if (order.state !== 'PaymentSettled') {
      ElMessage.error(`原单状态 ${order.state} 不允许退货`);
      return;
    }
    originalOrder.value = order;
  } catch (e) {
    ElMessage.error('查询失败：' + (e instanceof Error ? e.message : ''));
  } finally {
    searching.value = false;
  }
}

function setRefundQty(line: OriginalLine, qty: number) {
  const clamped = Math.max(0, Math.min(qty, line.quantity));
  refundQtys.value = { ...refundQtys.value, [line.id]: clamped };
}

async function handleSubmit() {
  if (!originalOrder.value || !hasRefundSelection.value) {
    ElMessage.warning('请选择退货商品并填写数量');
    return;
  }
  const refundLines = originalOrder.value.lines
    .filter(line => (refundQtys.value[line.id] ?? 0) > 0)
    .map(line => ({
      orderLineId: line.id,
      quantity: refundQtys.value[line.id],
      reason: refundReason.value || undefined,
    }));

  try {
    await ElMessageBox.confirm(
      `确认退款 ¥${formatMoney(refundTotal.value)}（现金）？`,
      '退货确认',
      { confirmButtonText: '确认退款', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }

  submitting.value = true;
  try {
    const { data, errors } = await apolloClient.mutate({
      mutation: CREATE_REFUND_ORDER,
      variables: {
        originalOrderId: originalOrder.value.id,
        refundLines,
      },
    });
    if (errors?.length) throw new Error(errors[0].message);
    const result = data?.createRefundOrder;
    if (!result) throw new Error('退货失败：无响应');

    const refundOrder = result.refundOrder;
    const paid = refundOrder.payments?.[0]?.amount ?? 0;
    ElMessage.success(
      `退货成功：${refundOrder.code}，退款 ¥${formatMoney(Math.abs(paid))}`,
    );
    handleBack();
  } catch (e) {
    ElMessage.error('退货失败：' + (e instanceof Error ? e.message : ''));
  } finally {
    submitting.value = false;
  }
}

function handleBack() {
  router.push('/cashier');
}
</script>

<template>
  <div class="refund-view">
    <header class="top-bar">
      <el-button text @click="handleBack">← 返回收银台</el-button>
      <span class="title">退货</span>
      <span class="placeholder"></span>
    </header>

    <main class="content">
      <!-- 原单查询 -->
      <section class="search-section">
        <div class="search-row">
          <el-input
            v-model="codeInput"
            placeholder="输入原单号"
            clearable
            @keyup.enter="handleSearch"
            class="code-input"
          />
          <el-button type="primary" :loading="searching" @click="handleSearch">
            查询
          </el-button>
        </div>
      </section>

      <!-- 原单明细 -->
      <section v-if="originalOrder" class="order-section">
        <div class="order-header">
          <span>订单号：{{ originalOrder.code }}</span>
          <span>状态：{{ originalOrder.state }}</span>
          <span>原金额：¥{{ formatMoney(originalOrder.totalWithTax) }}</span>
        </div>

        <div class="lines-table">
          <div class="line-row line-head">
            <div class="col-name">商品</div>
            <div class="col-qty">原数量</div>
            <div class="col-price">单价</div>
            <div class="col-refund">退货数量</div>
          </div>
          <div
            v-for="line in originalOrder.lines"
            :key="line.id"
            class="line-row"
          >
            <div class="col-name">
              <div class="name">{{ line.productVariant.name }}</div>
              <div class="sku">SKU: {{ line.productVariant.sku }}</div>
              <div class="tags">
                <el-tag v-if="line.customFields.isGift" size="small" type="info">赠品</el-tag>
                <el-tag v-if="line.customFields.memberPriceApplied" size="small" type="success">会员价</el-tag>
                <el-tag v-if="line.customFields.discount < 100" size="small" type="warning">
                  {{ line.customFields.discount }}%
                </el-tag>
              </div>
            </div>
            <div class="col-qty">{{ line.quantity }}</div>
            <div class="col-price">¥{{ formatMoney(line.unitPriceWithTax) }}</div>
            <div class="col-refund">
              <el-input-number
                :model-value="refundQtys[line.id] ?? 0"
                :min="0"
                :max="line.quantity"
                :step="1"
                size="small"
                @update:model-value="(v: number) => setRefundQty(line, v)"
              />
            </div>
          </div>
        </div>

        <div class="refund-summary">
          <div class="summary-row">
            <span>退款合计</span>
            <span class="refund-amount">¥{{ formatMoney(refundTotal) }}</span>
          </div>
          <div class="summary-row">
            <span>退款方式</span>
            <span class="method-tag">现金（钱箱弹出）</span>
          </div>
          <el-input
            v-model="refundReason"
            placeholder="退货原因（可选）"
            maxlength="100"
            show-word-limit
            class="reason-input"
          />
          <el-button
            type="danger"
            size="large"
            :disabled="!hasRefundSelection"
            :loading="submitting"
            @click="handleSubmit"
            class="submit-btn"
          >
            确认退货
          </el-button>
        </div>
      </section>

      <!-- 空状态 -->
      <section v-else-if="!searching" class="empty-section">
        <div class="empty-tip">请输入原单号查询</div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.refund-view {
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
.placeholder {
  width: 90px;
}
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow-y: auto;
  gap: 16px;
}
.search-section {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
}
.search-row {
  display: flex;
  gap: 12px;
}
.code-input {
  flex: 1;
}
.order-section {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.order-header {
  display: flex;
  gap: 24px;
  font-size: 13px;
  color: #606266;
  padding-bottom: 12px;
  border-bottom: 1px solid #ebeef5;
}
.lines-table {
  display: flex;
  flex-direction: column;
}
.line-row {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1.5fr;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid #f0f0f0;
  align-items: center;
}
.line-head {
  font-size: 12px;
  color: #909399;
  font-weight: 600;
  border-bottom: 1px solid #ebeef5;
}
.col-name .name {
  font-size: 14px;
  color: #303133;
  font-weight: 500;
}
.col-name .sku {
  font-size: 12px;
  color: #909399;
  margin-top: 2px;
}
.col-name .tags {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.col-qty,
.col-price {
  font-size: 14px;
  color: #606266;
}
.col-refund {
  display: flex;
  justify-content: flex-end;
}
.refund-summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid #ebeef5;
}
.summary-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 14px;
  color: #606266;
}
.refund-amount {
  font-size: 28px;
  font-weight: 700;
  color: #f56c6c;
}
.method-tag {
  font-size: 13px;
  color: #e6a23c;
  background: #fdf6ec;
  padding: 2px 10px;
  border-radius: 4px;
}
.reason-input {
  margin-top: 4px;
}
.submit-btn {
  margin-top: 8px;
  align-self: stretch;
}
.empty-section {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}
.empty-tip {
  color: #909399;
  font-size: 14px;
}
</style>
