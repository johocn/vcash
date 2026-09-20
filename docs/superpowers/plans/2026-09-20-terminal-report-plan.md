# 实现计划：终端维度报表

> 设计规格：`docs/superpowers/specs/2026-09-20-terminal-report-design.md`

## 目标
在报表中心新增「终端统计」：按收银终端聚合区间销售额/订单数/客单价/退款/支付方式，支持条形图与 CSV 导出。复用订单 `customFields.terminalCode`，无 schema 变更。

## 前置条件
- vcash 可 `pnpm -r build`（需 `../vendure` 的 cjk-plugin/member-level-plugin 就绪）。
- 前端 `pnpm build:web` 通过。

## 实施步骤

### Step 1 — 后端 ReportService.terminalSalesReport
文件：`packages/vcash-pos-plugin/src/services/report.service.ts`
1. 新增类型 `TerminalPaymentSummary` / `TerminalSalesItem` / `TerminalSalesReport`。
2. 复用现有私有方法新增公开方法：
   - 用 `findCustomFieldColumn('order','terminalCode')` 取实际列名；无列→返回空。
   - 分别查 sale / refund 区间订单并带 terminalCode 列。
   - 分桶聚合销售额/订单数/客单价（sale），退款额/笔数（refund abs），支付方式（Settled）。
   - `sortBy`：`amount`（总额降序，默认）/ `orders`（订单数降序），空 code 置「(未知)」并排末。
   - 返回 `{ startDate, endDate, totals, terminals }`（totals 为汇总项）。
3. 自检：与既有 `queryOrdersByDateRange` / `aggregatePaymentsByMethod` 口径一致。

### Step 2 — 后端 Resolver + Schema
文件：`packages/vcash-pos-plugin/src/resolvers/admin-report.resolver.ts`、`packages/vcash-pos-plugin/src/plugin.ts`
1. `admin-report.resolver.ts` 新增 `@Query() @Allow(Permission.ReadOrder) terminalSalesReport(ctx, startDate, endDate, sortBy='amount')`。
2. `plugin.ts` adminSchema 新增上述类型与 `extend type Query`。

### Step 3 — 前端 ReportView 新增 Tab
文件：`web/src/views/ReportView.vue`
1. `activeTab` 联合类型加 `'terminal'`；新增 GraphQL `TERMINAL_SALES_REPORT`。
2. 新增 `el-tab-pane label="终端统计"`：日期区间 + 排序下拉 + 查询 + 导出 CSV。
3. 汇总卡（总销售额/总订单）+ 表格（含支付方式展开）+ 横向条形图（复用 `.bar-chart`）。
4. CSV 导出 `exportTerminal()`。
5. 自检：无 console 错误，空数据显示空态。

### Step 4 — 单元测试
- 若有 pos-plugin spec 基建：`ReportService.terminalSalesReport` 分桶/退款/未知终端/sortBy/空数据用例。
- 否则在 server 仓库既有 e2e 测试目录补一条 Query 用例。
- 自检：`pnpm -r test` 相关用例通过。

### Step 5 — 构建与验证
1. `pnpm -r build` 后端通过。
2. `pnpm build:web` 前端通过。
3. 手机视口（390×844, dpr=2）截图「报表中心 → 终端统计」存入交付物。

## 验收
见设计文档 §6。回归：既有四项报表行为不变。

## 清单
- [ ] ReportService 方法
- [ ] Resolver + Schema
- [ ] ReportView Tab
- [ ] 测试
- [ ] 双端构建通过
- [ ] 手机截图