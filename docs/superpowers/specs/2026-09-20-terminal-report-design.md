# POS 终端维度报表（Terminal-Scoped Sales Report）设计

- 创建日期：2026-09-20
- 状态：Spec
- 目标仓库：vcash（Vendure 多租户多仓库 POS 收银系统）

---

## 1. 任务背景与目标

### 1.1 背景

vcash 报表系统（`ReportService`）当前提供四类统计，均为 **Channel（门店/租户）level** 聚合：

- `todayOverview`：今日概览
- `salesReport`：日/区间报表（按天）
- `monthlyReport`：月度报表（环比）
- `topProducts`：商品销量 TOP

实际连锁门店运营中，**一个门店可能有多个收银终端（PosTerminal）**，店长/老板需要区分「哪个收银台卖出最多、哪个收银台差异大」。当前无此维度，无法做终端之间的横向对比。

订单已持久化 `customFields.terminalCode`（下单终端编号快照），具备按终端聚合的数据基础，但报表服务从未使用该字段。

### 1.2 目标

新增 **终端维度销售报表**：

1. 按收银终端聚合区间内销售额、订单数、客单价。
2. 每个终端返回退款额、退款笔数、各支付方式汇总（便于对账）。
3. 报表中心新增「终端统计」Tab：表格 + 横向条形图 + CSV 导出。

### 1.3 非目标（YAGNI）

- 不做跨 Channel 的终端对比（Channel 隔离原则不变，报表仍限定当前 ctx.channelId）。
- 不做终端维度的实时「今日」卡（可复用区间=今日来等价查看），本期只加「区间终端报表」一个查询。
- 不改动既有四项报表行为。

---

## 2. 整体设计

### 2.1 数据模型

复用既有订单 `customFields.terminalCode`（string，可为空）。**无 schema 变更**。

- 为空/未知终端的订单归为 `terminalCode = '(未知)'` 一组，保证金额不漏算。
- 金额单位：分（int），前端 `/100` 展示，与既有报表一致。

### 2.2 后端：ReportService 新增方法

在 `packages/vcash-pos-plugin/src/services/report.service.ts` 新增：

```
async terminalSalesReport(ctx, startDate, endDate, sortBy: 'amount'|'orders'='amount')
  → Promise<TerminalSalesReport>
```

实现要点（沿用既有 `queryOrdersByDateRange` / `findCustomFieldColumn` 模式）：

1. 用 `findCustomFieldColumn('order', 'terminalCode')` 查实际列名；列不存在返回空结果。
2. 查询区间内 sale 订单（含 payments），同时 SELECT terminalCode 列。
3. 按 terminalCode 分桶聚合：
   - `totalAmount`：Σ total
   - `orderCount`
   - `avgOrderValue` = totalAmount / orderCount
   - `refundAmount` / `refundCount`：从同区间 refund 订单里按 terminalCode 分桶取 abs
   - `paymentsByMethod`：沿用 `aggregatePaymentsByMethod` 逻辑（仅 Settled）
4. `sortBy`：`amount` 按 totalAmount 降序，`orders` 按 orderCount 降序；terminalCode 空值组排最后。
5. 返回 `{ startDate, endDate, terminals: TerminalSalesItem[] }`，每项含 terminalCode、上列字段、合计行 `totals`。

### 2.3 后端：GraphQL Schema 与 Resolver

`plugin.ts` adminSchema 新增类型 + Query：

```graphql
type TerminalPaymentSummary { method: String!, count: Int!, amount: Int! }
type TerminalSalesItem {
  terminalCode: String!
  totalAmount: Int!
  orderCount: Int!
  avgOrderValue: Int!
  refundAmount: Int!
  refundCount: Int!
  paymentsByMethod: [TerminalPaymentSummary!]!
}
type TerminalSalesReport {
  startDate: String!
  endDate: String!
  totals: TerminalSalesItem!
  terminals: [TerminalSalesItem!]!
}

extend type Query {
  terminalSalesReport(startDate: String!, endDate: String!, sortBy: String): TerminalSalesReport!
}
```

`resolvers/admin-report.resolver.ts` 新增 `@Query() @Allow(Permission.ReadOrder) terminalSalesReport(...)`，`sortBy: 'amount'|'orders' = 'amount'`。

### 2.4 前端：ReportView 新增 Tab

`web/src/views/ReportView.vue`：

- `activeTab` 联合类型加 `'terminal'`。
- 新增 `el-tab-pane label="终端统计" name="terminal"`：
  - 日期区间选择器 + 排序下拉 + 查询 + 导出 CSV（复用 `exportCSV`）。
  - 顶部合计卡（区间总销售额、总订单数）。
  - 表格：终端、销售额、订单数、客单价、退款额、退款笔数 + 支付方式子表（展开）。
  - 横向条形图（复用现有 `.bar-chart` 样式，按排序展示各终端销售额占比）。
  - CSV 导出：标题含终端维度头。
- `methodLabels` 映射已存在，直接复用 `methodLabel()`。

---

## 3. 分箱 / 金额口径

- 仅统计 `orderType='sale'` 的销售单（现金/扫码/聚合均落在 Sale 单的 payments）。
- 退款单独分桶（refund Order 的 total 为负，取 abs）。
- 支付方式仅统计 `state='Settled'`，与 `todayOverview` 口径一致。

---

## 4. 错误处理

- 列不存在（schema 未同步）：返回空 `terminals` 与全零 `totals`，不抛错。
- 空区间：同上空结果。
- 参考既有`queryOrdersByDateRange` 的 PRAGMA 动态找列，避免命名策略差异。

---

## 5. 测试

对 `ReportService.terminalSalesReport` 写 Vitest 单元测试（构造内存 Order/OrderLine/Payment fixture，使用既有测试基建的模式）：

- 有 terminalCode 的订单正确分桶聚合（金额、订单数、退款、支付方式）。
- terminalCode 为空的订单归入 `(未知)`。
- `sortBy` 切换正确。
- 空数据 / 列不存在返回空结果不抛错。

（若当前 `vcash-pos-plugin` 无独立 spec 基建，则复用 server 仓库已有 e2e 测试目录的写法，新增一条 `terminalSalesReport` 用例。）

---

## 6. 验收标准

1. `todayOverview` / `salesReport` / `monthlyReport` / `topProducts` 行为不变。
2. 新增 Query 可调用，返回结构含 `totals` + `terminals`。
3. 前端「终端统计」Tab 表格、图表、CSV 导出可用。
4. 手机视口（390×844, dpr=2）截图：报表中心含终端统计 Tab 的中文展示。
5. 后端 `pnpm -r build` 通过；前端 `pnpm build:web` 通过。