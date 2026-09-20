<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import { formatMoney } from '@/utils/format';

// ===== GraphQL =====
const TODAY_OVERVIEW = gql`
  query TodayOverview {
    todayOverview {
      date totalAmount orderCount avgOrderValue refundAmount refundCount
      paymentsByMethod { method count amount }
    }
  }
`;
const SALES_REPORT = gql`
  query SalesReport($startDate: String!, $endDate: String!) {
    salesReport(startDate: $startDate, endDate: $endDate) {
      startDate endDate totalAmount totalOrders avgOrderValue
      daily { date totalAmount orderCount avgOrderValue }
    }
  }
`;
const MONTHLY_REPORT = gql`
  query MonthlyReport($year: Int!, $month: Int!) {
    monthlyReport(year: $year, month: $month) {
      year month totalAmount orderCount avgOrderValue
      prevMonth { totalAmount orderCount }
      amountChangeRate countChangeRate
    }
  }
`;
const TOP_PRODUCTS = gql`
  query TopProducts($startDate: String!, $endDate: String!, $limit: Int, $sortBy: String) {
    topProducts(startDate: $startDate, endDate: $endDate, limit: $limit, sortBy: $sortBy) {
      startDate endDate
      items { variantId variantName productName sku totalQuantity totalAmount }
    }
  }
`;

// ===== 类型 =====
interface PaymentMethodSummary { method: string; count: number; amount: number; }
interface TodayOverview {
  date: string; totalAmount: number; orderCount: number; avgOrderValue: number;
  refundAmount: number; refundCount: number; paymentsByMethod: PaymentMethodSummary[];
}
interface DailySales { date: string; totalAmount: number; orderCount: number; avgOrderValue: number; }
interface SalesReport {
  startDate: string; endDate: string; totalAmount: number; totalOrders: number;
  avgOrderValue: number; daily: DailySales[];
}
interface MonthlyReport {
  year: number; month: number; totalAmount: number; orderCount: number; avgOrderValue: number;
  prevMonth: { totalAmount: number; orderCount: number; };
  amountChangeRate: number; countChangeRate: number;
}
interface TopProductItem {
  variantId: string; variantName: string; productName: string; sku: string;
  totalQuantity: number; totalAmount: number;
}
interface TopProductReport { startDate: string; endDate: string; items: TopProductItem[]; }

// ===== Tab =====
const activeTab = ref<'today' | 'sales' | 'monthly' | 'top'>('today');
const router = useRouter();

// ===== 今日概览 =====
const todayData = ref<TodayOverview | null>(null);
const todayLoading = ref(false);

async function loadToday() {
  todayLoading.value = true;
  try {
    const { data } = await apolloClient.query<{ todayOverview: TodayOverview }>({
      query: TODAY_OVERVIEW,
      fetchPolicy: 'network-only',
    });
    todayData.value = data.todayOverview;
  } catch (e: any) {
    ElMessage.error('加载今日概览失败: ' + (e.message ?? e));
  } finally {
    todayLoading.value = false;
  }
}

// ===== 日/区间报表 =====
const salesDateRange = ref<[Date, Date]>([new Date(), new Date()]);
const salesData = ref<SalesReport | null>(null);
const salesLoading = ref(false);

async function loadSales() {
  if (!salesDateRange.value || salesDateRange.value.length !== 2) return;
  const [start, end] = salesDateRange.value;
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  salesLoading.value = true;
  try {
    const { data } = await apolloClient.query<{ salesReport: SalesReport }>({
      query: SALES_REPORT,
      variables: { startDate: fmt(start), endDate: fmt(end) },
      fetchPolicy: 'network-only',
    });
    salesData.value = data.salesReport;
  } catch (e: any) {
    ElMessage.error('加载销售报表失败: ' + (e.message ?? e));
  } finally {
    salesLoading.value = false;
  }
}

// ===== 月度报表 =====
const now = new Date();
const monthlyYear = ref(now.getFullYear());
const monthlyMonth = ref(now.getMonth() + 1);
const monthlyData = ref<MonthlyReport | null>(null);
const monthlyLoading = ref(false);

async function loadMonthly() {
  monthlyLoading.value = true;
  try {
    const { data } = await apolloClient.query<{ monthlyReport: MonthlyReport }>({
      query: MONTHLY_REPORT,
      variables: { year: monthlyYear.value, month: monthlyMonth.value },
      fetchPolicy: 'network-only',
    });
    monthlyData.value = data.monthlyReport;
  } catch (e: any) {
    ElMessage.error('加载月度报表失败: ' + (e.message ?? e));
  } finally {
    monthlyLoading.value = false;
  }
}

// ===== 商品销量 TOP =====
const topDateRange = ref<[Date, Date]>([new Date(), new Date()]);
const topSortBy = ref<'quantity' | 'amount'>('quantity');
const topLimit = ref(20);
const topData = ref<TopProductReport | null>(null);
const topLoading = ref(false);

async function loadTop() {
  if (!topDateRange.value || topDateRange.value.length !== 2) return;
  const [start, end] = topDateRange.value;
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  topLoading.value = true;
  try {
    const { data } = await apolloClient.query<{ topProducts: TopProductReport }>({
      query: TOP_PRODUCTS,
      variables: {
        startDate: fmt(start), endDate: fmt(end),
        limit: topLimit.value, sortBy: topSortBy.value,
      },
      fetchPolicy: 'network-only',
    });
    topData.value = data.topProducts;
  } catch (e: any) {
    ElMessage.error('加载商品销量失败: ' + (e.message ?? e));
  } finally {
    topLoading.value = false;
  }
}

// ===== SVG 图表计算 =====
// 销售趋势折线图（日/区间报表）
const salesChartPoints = computed(() => {
  if (!salesData.value || salesData.value.daily.length === 0) return '';
  const daily = salesData.value.daily;
  const maxAmount = Math.max(...daily.map(d => d.totalAmount), 1);
  const w = 100; // viewBox 宽度百分比
  const h = 100; // viewBox 高度百分比
  const stepX = daily.length > 1 ? w / (daily.length - 1) : 0;
  return daily.map((d, i) => {
    const x = i * stepX;
    const y = h - (d.totalAmount / maxAmount) * h;
    return `${x},${y}`;
  }).join(' ');
});

const salesChartMaxAmount = computed(() => {
  if (!salesData.value || salesData.value.daily.length === 0) return 0;
  return Math.max(...salesData.value.daily.map(d => d.totalAmount));
});

// 商品销量柱状图
const topChartBars = computed(() => {
  if (!topData.value || topData.value.items.length === 0) return [];
  const items = topData.value.items.slice(0, 10); // 最多显示前10
  const maxValue = topSortBy.value === 'quantity'
    ? Math.max(...items.map(i => i.totalQuantity), 1)
    : Math.max(...items.map(i => i.totalAmount), 1);
  return items.map((item, i) => ({
    name: item.variantName.length > 8 ? item.variantName.slice(0, 8) + '…' : item.variantName,
    value: topSortBy.value === 'quantity' ? item.totalQuantity : item.totalAmount,
    percent: ((topSortBy.value === 'quantity' ? item.totalQuantity : item.totalAmount) / maxValue) * 100,
    color: ['#409EFF', '#67C23A', '#E6A23C', '#F56C6C', '#909399', '#9B59B6', '#1ABC9C', '#34495E', '#E67E22', '#95A5A6'][i % 10],
  }));
});

// ===== CSV 导出 =====
function exportCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const csv = [
    headers.join(','),
    ...rows.map(r => r.map(c => {
      const s = String(c);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')),
  ].join('\n');
  // BOM 头确保 Excel 正确识别 UTF-8
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportToday() {
  if (!todayData.value) return;
  exportCSV(`今日概览_${todayData.value.date}.csv`,
    ['指标', '数值'],
    [
      ['日期', todayData.value.date],
      ['销售额(元)', formatMoney(todayData.value.totalAmount)],
      ['订单数', todayData.value.orderCount],
      ['客单价(元)', formatMoney(todayData.value.avgOrderValue)],
      ['退款额(元)', formatMoney(todayData.value.refundAmount)],
      ['退款数', todayData.value.refundCount],
      ...todayData.value.paymentsByMethod.map(p => [`支付方式:${p.method} 笔数`, p.count]),
      ...todayData.value.paymentsByMethod.map(p => [`支付方式:${p.method} 金额(元)`, formatMoney(p.amount)]),
    ],
  );
}

function exportSales() {
  if (!salesData.value) return;
  exportCSV(`销售报表_${salesData.value.startDate}_${salesData.value.endDate}.csv`,
    ['日期', '销售额(元)', '订单数', '客单价(元)'],
    salesData.value.daily.map(d => [d.date, formatMoney(d.totalAmount), d.orderCount, formatMoney(d.avgOrderValue)]),
  );
}

function exportMonthly() {
  if (!monthlyData.value) return;
  const m = monthlyData.value;
  exportCSV(`月度报表_${m.year}-${m.month}.csv`,
    ['指标', '当月', '上月', '环比变化率(%)'],
    [
      ['销售额(元)', formatMoney(m.totalAmount), formatMoney(m.prevMonth.totalAmount), m.amountChangeRate],
      ['订单数', m.orderCount, m.prevMonth.orderCount, m.countChangeRate],
      ['客单价(元)', formatMoney(m.avgOrderValue), m.prevMonth.orderCount > 0 ? formatMoney(Math.round(m.prevMonth.totalAmount / m.prevMonth.orderCount)) : '0.00', ''],
    ],
  );
}

function exportTop() {
  if (!topData.value) return;
  exportCSV(`商品销量TOP_${topData.value.startDate}_${topData.value.endDate}.csv`,
    ['排名', '商品名称', '规格名称', 'SKU', '销量', '销售额(元)'],
    topData.value.items.map((item, i) => [i + 1, item.productName, item.variantName, item.sku, item.totalQuantity, formatMoney(item.totalAmount)]),
  );
}

// ===== 支付方式名称映射 =====
const methodLabels: Record<string, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝',
  card: '银行卡',
  aggregate: '聚合支付',
};
function methodLabel(method: string): string {
  return methodLabels[method] ?? method;
}

// ===== 初始化 =====
onMounted(() => {
  loadToday();
});
</script>

<template>
  <div class="report-view">
    <div class="report-header">
      <el-button @click="router.push('/cashier')" :icon="null">返回收银</el-button>
      <h2>报表中心</h2>
      <div></div>
    </div>

    <el-tabs v-model="activeTab" class="report-tabs">
      <!-- ===== 今日概览 ===== -->
      <el-tab-pane label="今日概览" name="today">
        <div class="tab-actions">
          <el-button @click="loadToday" :loading="todayLoading">刷新</el-button>
          <el-button @click="exportToday" :disabled="!todayData">导出CSV</el-button>
        </div>
        <el-row :gutter="16" v-loading="todayLoading">
          <el-col :span="6">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">今日销售额</div>
              <div class="stat-value">¥{{ formatMoney(todayData?.totalAmount) }}</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">订单数</div>
              <div class="stat-value">{{ todayData?.orderCount ?? 0 }}</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">客单价</div>
              <div class="stat-value">¥{{ formatMoney(todayData?.avgOrderValue) }}</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">退款额</div>
              <div class="stat-value warn">¥{{ formatMoney(todayData?.refundAmount) }}</div>
              <div class="stat-sub">退款 {{ todayData?.refundCount ?? 0 }} 笔</div>
            </el-card>
          </el-col>
        </el-row>

        <el-card shadow="never" class="section-card">
          <template #header><span>支付方式汇总</span></template>
          <el-table :data="todayData?.paymentsByMethod ?? []" stripe>
            <el-table-column label="支付方式" min-width="120">
              <template #default="{ row }">{{ methodLabel(row.method) }}</template>
            </el-table-column>
            <el-table-column prop="count" label="笔数" width="100" />
            <el-table-column label="金额" min-width="120">
              <template #default="{ row }">¥{{ formatMoney(row.amount) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ===== 日/区间报表 ===== -->
      <el-tab-pane label="日/区间报表" name="sales">
        <div class="tab-actions">
          <el-date-picker
            v-model="salesDateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="x"
            :clearable="false"
            @change="loadSales"
          />
          <el-button @click="loadSales" :loading="salesLoading">查询</el-button>
          <el-button @click="exportSales" :disabled="!salesData">导出CSV</el-button>
        </div>

        <el-row :gutter="16" v-if="salesData">
          <el-col :span="8">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">区间总销售额</div>
              <div class="stat-value">¥{{ formatMoney(salesData.totalAmount) }}</div>
            </el-card>
          </el-col>
          <el-col :span="8">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">区间总订单数</div>
              <div class="stat-value">{{ salesData.totalOrders }}</div>
            </el-card>
          </el-col>
          <el-col :span="8">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">区间客单价</div>
              <div class="stat-value">¥{{ formatMoney(salesData.avgOrderValue) }}</div>
            </el-card>
          </el-col>
        </el-row>

        <!-- SVG 趋势折线图 -->
        <el-card shadow="never" class="section-card" v-if="salesData && salesData.daily.length > 0">
          <template #header><span>销售额趋势</span></template>
          <div class="chart-container" v-loading="salesLoading">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="trend-chart">
              <!-- 基线 -->
              <line x1="0" y1="100" x2="100" y2="100" stroke="#ddd" stroke-width="0.3" />
              <line x1="0" y1="0" x2="0" y2="100" stroke="#ddd" stroke-width="0.3" />
              <!-- 折线 -->
              <polyline :points="salesChartPoints" fill="none" stroke="#409EFF" stroke-width="0.8" />
              <!-- 数据点 -->
              <circle v-for="(p, i) in salesChartPoints.split(' ')" :key="i"
                :cx="p.split(',')[0]" :cy="p.split(',')[1]" r="0.8" fill="#409EFF" />
            </svg>
            <div class="chart-x-labels" v-if="salesData">
              <span v-for="d in salesData.daily" :key="d.date">{{ d.date.slice(5) }}</span>
            </div>
            <div class="chart-y-max">¥{{ formatMoney(salesChartMaxAmount) }}</div>
          </div>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><span>每日明细</span></template>
          <el-table :data="salesData?.daily ?? []" stripe v-loading="salesLoading">
            <el-table-column prop="date" label="日期" width="120" />
            <el-table-column label="销售额" min-width="120">
              <template #default="{ row }">¥{{ formatMoney(row.totalAmount) }}</template>
            </el-table-column>
            <el-table-column prop="orderCount" label="订单数" width="100" />
            <el-table-column label="客单价" min-width="120">
              <template #default="{ row }">¥{{ formatMoney(row.avgOrderValue) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ===== 月度报表 ===== -->
      <el-tab-pane label="月度报表" name="monthly">
        <div class="tab-actions">
          <el-date-picker
            v-model="monthlyMonth"
            type="month"
            placeholder="选择月份"
            :clearable="false"
            @change="(val: Date) => { monthlyYear = val.getFullYear(); monthlyMonth = val.getMonth() + 1; loadMonthly(); }"
          />
          <el-button @click="loadMonthly" :loading="monthlyLoading">查询</el-button>
          <el-button @click="exportMonthly" :disabled="!monthlyData">导出CSV</el-button>
        </div>

        <el-row :gutter="16" v-if="monthlyData">
          <el-col :span="6">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">{{ monthlyData.year }}年{{ monthlyData.month }}月销售额</div>
              <div class="stat-value">¥{{ formatMoney(monthlyData.totalAmount) }}</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">订单数</div>
              <div class="stat-value">{{ monthlyData.orderCount }}</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">客单价</div>
              <div class="stat-value">¥{{ formatMoney(monthlyData.avgOrderValue) }}</div>
            </el-card>
          </el-col>
          <el-col :span="6">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-label">环比销售额</div>
              <div class="stat-value" :class="{ up: monthlyData.amountChangeRate > 0, down: monthlyData.amountChangeRate < 0 }">
                {{ monthlyData.amountChangeRate > 0 ? '+' : '' }}{{ monthlyData.amountChangeRate }}%
              </div>
              <div class="stat-sub">上月 ¥{{ formatMoney(monthlyData.prevMonth.totalAmount) }}</div>
            </el-card>
          </el-col>
        </el-row>

        <el-card shadow="never" class="section-card" v-if="monthlyData">
          <template #header><span>环比对比</span></template>
          <el-table :data="[
            { label: '销售额', current: formatMoney(monthlyData.totalAmount), prev: formatMoney(monthlyData.prevMonth.totalAmount), rate: monthlyData.amountChangeRate },
            { label: '订单数', current: String(monthlyData.orderCount), prev: String(monthlyData.prevMonth.orderCount), rate: monthlyData.countChangeRate },
          ]" stripe>
            <el-table-column prop="label" label="指标" width="120" />
            <el-table-column label="当月" min-width="120">
              <template #default="{ row }">{{ row.label.includes('额') ? '¥' + row.current : row.current }}</template>
            </el-table-column>
            <el-table-column label="上月" min-width="120">
              <template #default="{ row }">{{ row.label.includes('额') ? '¥' + row.prev : row.prev }}</template>
            </el-table-column>
            <el-table-column label="环比变化率" min-width="120">
              <template #default="{ row }">
                <span :class="{ up: row.rate > 0, down: row.rate < 0 }">
                  {{ row.rate > 0 ? '+' : '' }}{{ row.rate }}%
                </span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ===== 商品销量 TOP ===== -->
      <el-tab-pane label="商品销量TOP" name="top">
        <div class="tab-actions">
          <el-date-picker
            v-model="topDateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="x"
            :clearable="false"
            @change="loadTop"
          />
          <el-select v-model="topSortBy" style="width: 120px" @change="loadTop">
            <el-option label="按销量" value="quantity" />
            <el-option label="按金额" value="amount" />
          </el-select>
          <el-input-number v-model="topLimit" :min="5" :max="100" :step="5" style="width: 120px" @change="loadTop" />
          <el-button @click="loadTop" :loading="topLoading">查询</el-button>
          <el-button @click="exportTop" :disabled="!topData">导出CSV</el-button>
        </div>

        <!-- SVG 柱状图 -->
        <el-card shadow="never" class="section-card" v-if="topData && topChartBars.length > 0">
          <template #header><span>销量排行 TOP 10（{{ topSortBy === 'quantity' ? '按销量' : '按金额' }}）</span></template>
          <div class="bar-chart">
            <div v-for="(bar, i) in topChartBars" :key="i" class="bar-row">
              <span class="bar-name" :title="topData.items[i].variantName">{{ i + 1 }}. {{ bar.name }}</span>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: bar.percent + '%', backgroundColor: bar.color }"></div>
              </div>
              <span class="bar-value">
                {{ topSortBy === 'quantity' ? bar.value : '¥' + formatMoney(bar.value) }}
              </span>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" class="section-card">
          <template #header><span>明细</span></template>
          <el-table :data="topData?.items ?? []" stripe v-loading="topLoading">
            <el-table-column type="index" label="排名" width="70" />
            <el-table-column prop="productName" label="商品名称" min-width="150" />
            <el-table-column prop="variantName" label="规格" min-width="120" />
            <el-table-column prop="sku" label="SKU" width="120" />
            <el-table-column prop="totalQuantity" label="销量" width="80" sortable />
            <el-table-column label="销售额" min-width="120" sortable :sort-method="(a: TopProductItem, b: TopProductItem) => a.totalAmount - b.totalAmount">
              <template #default="{ row }">¥{{ formatMoney(row.totalAmount) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.report-view {
  padding: 16px;
  max-width: 1200px;
  margin: 0 auto;
}
.report-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.report-header h2 {
  margin: 0;
  font-size: 20px;
}
.report-tabs {
  min-height: 400px;
}
.tab-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.stat-card {
  text-align: center;
  margin-bottom: 16px;
}
.stat-label {
  font-size: 13px;
  color: #909399;
  margin-bottom: 8px;
}
.stat-value {
  font-size: 24px;
  font-weight: 600;
  color: #303133;
}
.stat-value.warn {
  color: #E6A23C;
}
.stat-value.up {
  color: #67C23A;
}
.stat-value.down {
  color: #F56C6C;
}
.stat-sub {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
.section-card {
  margin-top: 16px;
}
.chart-container {
  position: relative;
  height: 240px;
  padding: 16px 0;
}
.trend-chart {
  width: 100%;
  height: 200px;
  border-left: 1px solid #ddd;
  border-bottom: 1px solid #ddd;
}
.chart-x-labels {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #909399;
  margin-top: 4px;
}
.chart-y-max {
  position: absolute;
  top: 16px;
  left: 0;
  font-size: 11px;
  color: #909399;
}
.bar-chart {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar-name {
  width: 120px;
  font-size: 13px;
  color: #606266;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.bar-track {
  flex: 1;
  height: 20px;
  background: #f5f7fa;
  border-radius: 4px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}
.bar-value {
  width: 100px;
  font-size: 13px;
  color: #303133;
  font-weight: 600;
  text-align: right;
  flex-shrink: 0;
}
</style>
