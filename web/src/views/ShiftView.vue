<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import { useSessionStore } from '@/stores/session';
import { useOfflineStore } from '@/stores/offline';
import { formatMoney } from '@/utils/format';
import { db, type OfflineSessionRecord, type ShiftSummary } from '@/db/dexie';
import { genIdempotencyKey } from '@/utils/idempotency';

const SHIFT_REPORT_PREVIEW = gql`
  query ShiftReportPreview($sessionId: ID!, $closingCash: Int) {
    shiftReportPreview(sessionId: $sessionId, closingCash: $closingCash)
  }
`;

interface ShiftSummaryLocal {
  orders: {
    totalCount: number;
    totalAmount: number;
    normalCount: number;
    refundCount: number;
    refundAmount: number;
    heldCount: number;
  };
  paymentsByMethod: Array<{ method: string; count: number; amount: number }>;
  warnings: string[];
}

const router = useRouter();
const sessionStore = useSessionStore();
const offlineStore = useOfflineStore();

const session = computed(() => sessionStore.currentSession);
const summary = ref<ShiftSummaryLocal | null>(null);
const loading = ref(false);
const closing = ref(false);
const isOnline = computed(() => offlineStore.isOnline);
// 实交现金输入（元）
const closingCashYuan = ref<number | null>(null);
let refreshSeq = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const openingFloat = computed(() => session.value?.openingFloat ?? 0);

// 应收现金 = 备用金 + 现金支付金额
const expectedCash = computed(() => {
  const cashPay = summary.value?.paymentsByMethod?.find((p) => p.method === 'cash');
  return openingFloat.value + (cashPay?.amount ?? 0);
});

// 实交现金（分）
const closingCashCents = computed(() => {
  if (closingCashYuan.value == null) return null;
  return Math.round(closingCashYuan.value * 100);
});

// 差额（分）：实交 - 应收
const cashDiff = computed(() => {
  if (closingCashCents.value == null) return null;
  return closingCashCents.value - expectedCash.value;
});

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

async function loadSummary() {
  if (!session.value) return;
  // 离线时无法调用后端对账单预览，跳过（保留上次本地快照或为空）
  if (!isOnline.value) return;
  const mySeq = ++refreshSeq;
  loading.value = true;
  try {
    const { data, errors } = await apolloClient.query({
      query: SHIFT_REPORT_PREVIEW,
      variables: {
        sessionId: session.value.id,
        closingCash: closingCashCents.value,
      },
      fetchPolicy: 'network-only',
    });
    if (mySeq !== refreshSeq) return;
    if (errors?.length && !data) throw new Error(errors[0].message);
    summary.value = (data?.shiftReportPreview ?? null) as ShiftSummaryLocal | null;
  } catch (e) {
    if (mySeq !== refreshSeq) return;
    ElMessage.error('加载对账单失败：' + (e instanceof Error ? e.message : ''));
  } finally {
    if (mySeq === refreshSeq) loading.value = false;
  }
}

function handleClosingCashChange() {
  if (!isOnline.value) return;
  // 防抖刷新对账单（传入 closingCash 触发现金对账 warnings）
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    loadSummary();
  }, 400);
}

/** 离线关班：本地生成对账单 + 写 IndexedDB sessions 表 */
async function handleOfflineClose() {
  if (!session.value) return;
  const sess = session.value;
  const now = new Date().toISOString();

  // 从本地 db.orders 构建最小对账单快照
  const localOrders = sess.code
    ? await db.orders.where('sessionCode').equals(sess.code).toArray()
    : [];
  const localSummary: ShiftSummary = {
    orders: {
      totalCount: localOrders.length,
      totalAmount: localOrders.reduce((s, o) => s + o.totalAmount, 0),
      normalCount: localOrders.filter((o) => o.orderType === 'sale').length,
      refundCount: localOrders.filter((o) => o.orderType === 'refund').length,
      refundAmount: localOrders
        .filter((o) => o.orderType === 'refund')
        .reduce((s, o) => s + o.totalAmount, 0),
      heldCount: localOrders.filter((o) => o.orderType === 'hold').length,
    },
    paymentsByMethod: [],
    warnings: ['离线关班，对账单为本地快照，联网同步后以服务端为准'],
  };

  const record: OfflineSessionRecord = {
    code: sess.code,
    idempotencyKey: genIdempotencyKey('session'),
    clientCreatedAt: now,
    clientUpdatedAt: now,
    terminalCode: sess.terminal?.code ?? '',
    operatorId: sess.operator?.id ? Number(sess.operator.id) : undefined,
    state: 'closed',
    openedAt: sess.openedAt ?? now,
    closedAt: now,
    openingFloat: sess.openingFloat ?? 0,
    closingCash: closingCashCents.value ?? undefined,
    localSummary,
    syncStatus: 'pending',
  };

  try {
    await db.sessions.put(record);
    sessionStore.reset();
    await offlineStore.updateCounts();
    ElMessage.success('已离线保存，联网后自动同步');
    router.replace('/setup');
  } catch (e) {
    ElMessage.error('离线关班失败：' + (e instanceof Error ? e.message : ''));
  }
}

async function handleCloseSession() {
  if (!session.value) return;
  try {
    await ElMessageBox.confirm('确认关班？关班后将无法继续收银。', '关班确认', {
      confirmButtonText: '确认关班',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return; // 用户取消
  }
  if (!isOnline.value) {
    await handleOfflineClose();
    return;
  }
  closing.value = true;
  try {
    await sessionStore.closeSession(
      session.value.id,
      closingCashCents.value ?? undefined,
    );
    ElMessage.success('关班成功');
    router.replace('/setup');
  } catch (e) {
    ElMessage.error('关班失败：' + (e instanceof Error ? e.message : ''));
  } finally {
    closing.value = false;
  }
}

function handleBackToCashier() {
  router.push('/cashier');
}

function handleRefresh() {
  loadSummary();
}

onMounted(() => {
  if (isOnline.value) loadSummary();
});

watch(closingCashYuan, handleClosingCashChange);
</script>

<template>
  <div class="shift-view">
    <!-- 顶部：班次信息 + 网络状态 -->
    <header class="top-bar">
      <el-button text @click="handleBackToCashier">← 返回收银台</el-button>
      <span class="title">
        班次管理
        <span class="net-badge" :class="isOnline ? 'online' : 'offline'">
          {{ isOnline ? '● 在线' : '● 离线' }}
        </span>
      </span>
      <el-button text @click="handleRefresh" :loading="loading" :disabled="!isOnline">刷新</el-button>
    </header>

    <main class="content" v-loading="loading">
      <!-- 班次信息卡片 -->
      <el-card class="session-card" shadow="never">
        <template #header><span class="card-title">当前班次</span></template>
        <div class="session-grid">
          <div class="info-item">
            <span class="label">班次号</span>
            <span class="value">{{ session?.code || '-' }}</span>
          </div>
          <div class="info-item">
            <span class="label">终端</span>
            <span class="value">
              {{ session?.terminal?.code || '-' }}
              <span class="sub" v-if="session?.terminal?.name">
                ({{ session.terminal.name }})
              </span>
            </span>
          </div>
          <div class="info-item">
            <span class="label">操作员</span>
            <span class="value">{{ session?.operator?.identifier || '-' }}</span>
          </div>
          <div class="info-item">
            <span class="label">开班时间</span>
            <span class="value">
              {{ session?.openedAt ? new Date(session.openedAt).toLocaleString('zh-CN') : '-' }}
            </span>
          </div>
          <div class="info-item">
            <span class="label">备用金</span>
            <span class="value">¥{{ formatMoney(openingFloat) }}</span>
          </div>
        </div>
      </el-card>

      <!-- 对账单 -->
      <el-card class="report-card" shadow="never">
        <template #header><span class="card-title">对账单</span></template>
        <div v-if="!isOnline" class="offline-banner">
          离线模式：对账单预览不可用，关班后将本地保存，联网同步后以服务端对账为准
        </div>
        <div v-if="summary">
          <!-- 订单统计 -->
          <div class="section">
            <div class="section-title">订单统计</div>
            <div class="stat-grid">
              <div class="stat">
                <span class="stat-label">总笔数</span>
                <span class="stat-value">{{ summary.orders.totalCount }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">销售额</span>
                <span class="stat-value">¥{{ formatMoney(summary.orders.totalAmount) }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">退货数</span>
                <span class="stat-value">{{ summary.orders.refundCount }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">退货额</span>
                <span class="stat-value">¥{{ formatMoney(summary.orders.refundAmount) }}</span>
              </div>
              <div class="stat">
                <span class="stat-label">挂单数</span>
                <span class="stat-value">{{ summary.orders.heldCount }}</span>
              </div>
            </div>
          </div>

          <el-divider />

          <!-- 支付方式明细 -->
          <div class="section">
            <div class="section-title">支付方式明细</div>
            <el-table
              :data="summary.paymentsByMethod"
              size="small"
              empty-text="暂无支付记录"
            >
              <el-table-column label="方式">
                <template #default="{ row }">{{ methodLabel(row.method) }}</template>
              </el-table-column>
              <el-table-column prop="count" label="笔数" width="100" />
              <el-table-column label="金额">
                <template #default="{ row }">
                  ¥{{ formatMoney(row.amount) }}
                </template>
              </el-table-column>
            </el-table>
          </div>

          <el-divider />

          <!-- 现金对账 -->
          <div class="section">
            <div class="section-title">现金对账</div>
            <div class="reconcile-grid">
              <div class="info-item">
                <span class="label">应收现金</span>
                <span class="value">¥{{ formatMoney(expectedCash) }}</span>
              </div>
              <div class="info-item">
                <span class="label">实交现金（元）</span>
                <el-input-number
                  v-model="closingCashYuan"
                  :min="0"
                  :precision="2"
                  :step="100"
                  placeholder="0.00"
                  size="small"
                />
              </div>
              <div class="info-item" v-if="cashDiff != null">
                <span class="label">差额</span>
                <span
                  class="value"
                  :class="{
                    positive: cashDiff > 0,
                    negative: cashDiff < 0,
                    zero: cashDiff === 0,
                  }"
                >
                  {{ cashDiff > 0 ? '长' : cashDiff < 0 ? '短' : '平' }}
                  ¥{{ formatMoney(Math.abs(cashDiff)) }}
                </span>
              </div>
            </div>
            <el-alert
              v-for="(w, idx) in summary.warnings"
              :key="idx"
              :title="w"
              type="warning"
              show-icon
              :closable="false"
              style="margin-top: 12px"
            />
          </div>
        </div>
        <div v-else-if="!loading && isOnline" class="empty">暂无对账数据</div>
      </el-card>
    </main>

    <!-- 底部：关班 -->
    <footer class="footer">
      <el-button
        type="danger"
        size="large"
        :loading="closing"
        @click="handleCloseSession"
      >
        关班
      </el-button>
    </footer>
  </div>
</template>

<style scoped>
.shift-view {
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
  display: inline-flex;
  align-items: center;
  gap: 8px;
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
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.card-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}
.session-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.info-item .label {
  font-size: 12px;
  color: #909399;
}
.info-item .value {
  font-size: 14px;
  color: #303133;
  font-weight: 500;
}
.info-item .sub {
  color: #909399;
  font-weight: 400;
}
.offline-banner {
  padding: 8px 12px;
  margin-bottom: 12px;
  background: #fdf6ec;
  color: #e6a23c;
  border-radius: 6px;
  font-size: 13px;
}
.section {
  margin-bottom: 4px;
}
.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 12px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 6px;
}
.stat-label {
  font-size: 12px;
  color: #909399;
}
.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}
.reconcile-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  align-items: end;
}
.value.positive {
  color: #67c23a;
}
.value.negative {
  color: #f56c6c;
}
.value.zero {
  color: #909399;
}
.empty {
  text-align: center;
  color: #909399;
  padding: 40px 0;
}
.footer {
  display: flex;
  justify-content: center;
  padding: 16px;
  background: #fff;
  border-top: 1px solid #ebeef5;
  flex-shrink: 0;
}
</style>
