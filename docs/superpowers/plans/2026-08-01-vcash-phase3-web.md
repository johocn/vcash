# vcash Phase 3: 前端在线收银 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 实现 Vue3 SPA 在线收银最小闭环：登录 → 选终端 → 开班 → 加商品/扫码 → 结账（现金/聚合码） → 关班对账。

**Architecture:** Vite + Vue3 (script setup) + TypeScript strict + Pinia + Vue Router + Apollo Client + Element Plus + GraphQL Codegen。前端独立 package（`vcash/web`），通过 Admin API 与 Vendure 通信。

**Spec 参考:** `docs/superpowers/specs/2026-08-01-vcash-redesign-design.md` §2.3 web 目录结构、§4.3 POS Admin API

**Phase 2 成果:** vcash-pos-plugin 45 测试通过（PosTerminal/PosSession/Order/AggregatePay/Refund/ShiftReport）

---

## 关键卡点与约束（Subagent 必读）

1. **双 Header 认证机制（核心卡点）**
   - **Session 认证**：`tokenMethod: 'bearer'` 模式下，`login` mutation 成功后 Vendure 在 **response header** `vendure-auth-token` 中返回 session token（不在 response body 中！）。前端必须用自定义 fetch 包装从 header 读取并存 localStorage，后续请求用 `Authorization: Bearer <session-token>` header 注入
   - **Channel 路由**：`login` 返回 `CurrentUser.channels: [{ id, token, code, permissions }]`。多租户场景一个 Administrator 可属于多个 Channel。前端选 Channel 后用该 Channel 的 `token` 注入 `vendure-token` header
   - **两个 header 缺一不可**：`Authorization: Bearer <session>` 做会话认证，`vendure-token: <channel>` 做 Channel 路由
   - **切换 Channel** = 切换 `vendure-token` header + 清空 Apollo 缓存 + 重查 posTerminals/posActiveOrder
   - **Apollo 实现**：用 `ApolloLink.from([authLink, channelLink, httpLink])`，authLink 和 channelLink 都是 setContext link，从 localStorage/auth store 注入对应 header

2. **Active Order 同步**
   - 前端 cart store 必须与后端 `posActiveOrder` query 保持一致
   - 进入 CashierView 时先查 `posActiveOrder`，有则加载到 cart store
   - addPosItem/updatePosItem 返回最新 Order，直接更新 cart store
   - 结账后 cart store 清空（后端 activeOrderId 也已置空）

3. **聚合码支付轮询**
   - `createAggregatePay` 后拿到 paymentId
   - 前端用 `aggregatePayByCode` 或 `aggregatePayStatus` 每 2s 轮询
   - 超时 5 分钟（150 次）后提示收银员"客户未付款，是否取消"
   - 轮询到 `state=Authorized` → 自动调 `settleAggregatePay`
   - 轮询到 `state=Cancelled` → 提示失败

4. **商品查询**
   - 用 Vendure 原生 `products` Admin API query，按 Channel 自动隔离
   - 支持 `term`（名称/SKU 模糊搜索）+ `collectionId`（分类）+ 分页
   - 商品网格懒加载，分类栏切换时重新查询

5. **扫码枪（HID 仿真）**
   - KeyboardEvent 监听：快速连续输入（间隔 <50ms）+ Enter 结束 = 扫码
   - 人工输入（间隔 >50ms）忽略
   - 扫码后按条码查询商品变体，找到则 addPosItem

6. **认证持久化**
   - 登录后 **session token**（从 `vendure-auth-token` response header 读取）存 `localStorage.vcash_session`
   - **channels 数组**存 `localStorage.vcash_channels`
   - **activeChannelId + activeChannelToken** 存 `localStorage.vcash_active_channel`
   - 退出登录清空以上三项

7. **路由守卫**
   - `/login` → 无需认证
   - `/setup` → 需认证，未选终端/未开班
   - `/cashier`, `/checkout`, `/shift` → 需认证 + 已开班
   - 未登录 → `/login`；已登录未开班 → `/setup`；已开班 → `/cashier`

---

## File Structure

```
vcash/web/
├── src/
│   ├── api/
│   │   ├── client.ts              # Apollo 客户端 + vendure-token 注入
│   │   ├── operations/
│   │   │   ├── auth.graphql       # login/me/logout
│   │   │   ├── terminal.graphql   # posTerminals/createPosTerminal
│   │   │   ├── session.graphql    # openSession/closeSession/myPosSession
│   │   │   ├── product.graphql    # products query
│   │   │   ├── order.graphql      # posActiveOrder/addPosItem/updatePosItem/checkoutPosOrder
│   │   │   └── aggregate-pay.graphql
│   │   └── types.ts               # codegen 产物（自动生成）
│   ├── stores/
│   │   ├── auth.ts                # 登录态 + channels + activeChannel
│   │   ├── session.ts             # 当前班次
│   │   └── cart.ts                # 购物车（与 posActiveOrder 同步）
│   ├── composables/
│   │   ├── useScanner.ts          # HID 扫码枪
│   │   └── useAggregatePayPolling.ts
│   ├── views/
│   │   ├── LoginView.vue          # 登录页
│   │   ├── SetupView.vue          # 选 Channel + 选终端 + 开班
│   │   ├── CashierView.vue        # 收银台主界面
│   │   ├── CheckoutView.vue       # 结账页
│   │   └── ShiftView.vue          # 班次管理 + 对账
│   ├── components/
│   │   ├── ProductGrid.vue
│   │   ├── CategoryBar.vue
│   │   ├── CartPanel.vue
│   │   ├── PaymentMethodBar.vue
│   │   └── AggregatePayPanel.vue
│   ├── router.ts
│   ├── App.vue
│   └── main.ts
├── codegen.ts
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Task 1: 脚手架 + 认证 + Channel 切换 + SetupView

**Files:**
- Create: `vcash/web/package.json`
- Create: `vcash/web/tsconfig.json`
- Create: `vcash/web/vite.config.ts`
- Create: `vcash/web/codegen.ts`
- Create: `vcash/web/index.html`
- Create: `vcash/web/src/main.ts`
- Create: `vcash/web/src/App.vue`
- Create: `vcash/web/src/router.ts`
- Create: `vcash/web/src/api/client.ts`
- Create: `vcash/web/src/api/operations/auth.graphql`
- Create: `vcash/web/src/api/operations/terminal.graphql`
- Create: `vcash/web/src/api/operations/session.graphql`
- Create: `vcash/web/src/stores/auth.ts`
- Create: `vcash/web/src/stores/session.ts`
- Create: `vcash/web/src/views/LoginView.vue`
- Create: `vcash/web/src/views/SetupView.vue`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@vcash/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b && vite build",
    "preview": "vite preview",
    "codegen": "graphql-codegen"
  },
  "dependencies": {
    "@apollo/client": "^3.11.0",
    "@vue/apollo-composable": "^4.0.2",
    "element-plus": "^2.8.0",
    "graphql": "^16.9.0",
    "pinia": "^2.2.0",
    "vue": "^3.5.0",
    "vue-router": "^4.4.0"
  },
  "devDependencies": {
    "@graphql-codegen/cli": "^5.0.0",
    "@graphql-codegen/client-preset": "^4.3.0",
    "@vitejs/plugin-vue": "^5.1.0",
    "graphql-codegen-vue-apollo": "^0.0.3",
    "typescript": "^5.5.0",
    "vite": "^5.4.0",
    "vue-tsc": "^2.1.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json（strict）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "types": ["vite/client"],
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "src/**/*.graphql"]
}
```

- [ ] **Step 3: 创建 vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5174,
    proxy: {
      '/admin-api': { target: 'http://localhost:3000/admin-api', changeOrigin: true },
    },
  },
});
```

- [ ] **Step 4: 创建 codegen.ts**

```typescript
import type { CodegenConfig } from '@graphql-codegen/cli';

export default {
  schema: 'http://localhost:3000/admin-api',
  documents: ['src/api/operations/**/*.graphql'],
  generates: { 'src/api/types.ts': { preset: 'client' } },
} satisfies CodegenConfig;
```

- [ ] **Step 5: 创建 src/api/client.ts**

Apollo httpLink 指向 `/admin-api`，header 注入 `vendure-token`（从 auth store 取 activeChannelToken）。

- [ ] **Step 6: 创建 auth.graphql**

```graphql
mutation Login($username: String!, $password: String!) {
  login(username: $username, password: $password, rememberMe: true) {
    ... on CurrentUser {
      id identifier
      channels { id token code permissions }
    }
    ... on InvalidCredentialsError { errorCode message }
  }
}

query Me { me { id identifier channels { id token code permissions } } }

mutation Logout { logout { success } }
```

- [ ] **Step 7: 创建 terminal.graphql + session.graphql**

```graphql
query PosTerminals($channelId: ID) {
  posTerminals(channelId: $channelId) { id code name active channel { id code } stockLocation { id name } }
}

mutation OpenSession($terminalCode: String!, $openingFloat: Int) {
  openSession(input: { terminalCode: $terminalCode, openingFloat: $openingFloat }) {
    id code state openedAt openingFloat
  }
}

query MyPosSession { myPosSession { id code state openedAt openingFloat terminal { id code name } } }
```

- [ ] **Step 8: 创建 stores/auth.ts**

```typescript
// Pinia store: token, channels, activeChannelId, activeChannelToken
// login(username, password) → 存 token + channels
// switchChannel(channelId) → 切换 activeChannel + 更新 Apollo header + 清缓存
// logout() → 清空 + 跳 /login
```

- [ ] **Step 9: 创建 stores/session.ts**

```typescript
// Pinia store: currentSession (PosSession | null)
// loadMySession() → myPosSession query
// openSession(terminalCode, openingFloat) → openSession mutation
// closeSession(sessionId, closingCash) → closeSession mutation
```

- [ ] **Step 10: 创建 LoginView.vue**

Element Plus 表单：username + password → 调 auth store login → 成功跳 /setup。

- [ ] **Step 11: 创建 SetupView.vue**

- 顶部 Channel 选择器（el-select，从 auth.channels 取）
- 终端列表（posTerminals query，按选中 Channel 过滤）
- 选终端后填"备用金"输入框 → 点"开班"调 openSession → 成功跳 /cashier
- 若 myPosSession 已有开班，直接显示"当前已开班"并跳 /cashier

- [ ] **Step 12: 创建 router.ts + 路由守卫**

```typescript
// /login → LoginView（无需认证）
// /setup → SetupView（需认证）
// /cashier → CashierView（需认证 + 已开班）
// /checkout → CheckoutView（需认证 + 已开班 + cart 非空）
// /shift → ShiftView（需认证 + 已开班）
// 守卫：未登录 → /login；已登录未开班 → /setup；已开班访问 /setup → /cashier
```

- [ ] **Step 13: 创建 main.ts + App.vue**

注册 Pinia + Router + Element Plus + Apollo。

- [ ] **Step 14: 安装依赖 + codegen + 启动验证**

```bash
cd vcash/web && pnpm install && pnpm codegen && pnpm dev
```

验证：能访问 http://localhost:5174/login，用 superadmin 登录成功跳 /setup。

- [ ] **Step 15: Commit**

```bash
git commit -m "feat(web): 脚手架 + 认证 + Channel 切换 + SetupView"
```

---

## Task 2: CashierView（商品查询 + 购物车 + 扫码枪）

**Files:**
- Create: `vcash/web/src/api/operations/product.graphql`
- Create: `vcash/web/src/api/operations/order.graphql`
- Create: `vcash/web/src/stores/cart.ts`
- Create: `vcash/web/src/composables/useScanner.ts`
- Create: `vcash/web/src/views/CashierView.vue`
- Create: `vcash/web/src/components/ProductGrid.vue`
- Create: `vcash/web/src/components/CategoryBar.vue`
- Create: `vcash/web/src/components/CartPanel.vue`

- [ ] **Step 1: 创建 product.graphql**

```graphql
query Products($term: String, $collectionId: ID, $take: Int, $skip: Int) {
  products(options: { filter: { name: { contains: $term } }, take: $take, skip: $skip }) {
    items {
      id name slug
      variants { id sku name price priceWithTax }
      featuredAsset { preview }
    }
    totalItems
  }
}
```

- [ ] **Step 2: 创建 order.graphql**

```graphql
query PosActiveOrder {
  posActiveOrder {
    id state total totalWithTax
    lines { id productVariant { id sku name } unitPrice unitPriceWithTax quantity linePriceWithTax
      customFields { originalPrice discount memberPriceApplied isGift note }
    }
  }
}

mutation AddPosItem($productVariantId: ID!, $quantity: Int!) {
  addPosItem(input: { productVariantId: $productVariantId, quantity: $quantity }) {
    id state total totalWithTax
    lines { id productVariant { id sku name } unitPriceWithTax quantity linePriceWithTax }
  }
}

mutation UpdatePosItem($orderLineId: ID!, $quantity: Int!) {
  updatePosItem(input: { orderLineId: $orderLineId, quantity: $quantity }) {
    id state total totalWithQty
    lines { id quantity linePriceWithTax }
  }
}
```

- [ ] **Step 3: 创建 stores/cart.ts**

```typescript
// Pinia store: order (Order | null), loading
// loadActiveOrder() → posActiveOrder query → 存 order
// addItem(variantId, qty) → addPosItem mutation → 更新 order
// updateItem(lineId, qty) → updatePosItem mutation → 更新 order
// clear() → order = null
// getters: lines, totalWithTax, itemCount
```

- [ ] **Step 4: 创建 useScanner.ts**

```typescript
// HID 扫码枪 composable
// 监听 window keydown：间隔 <50ms 的连续输入 + Enter = 扫码
// 人工输入（间隔 >50ms）忽略
// onScan(barcode) 回调
// onMounted 绑定，onUnmounted 解绑
```

- [ ] **Step 5: 创建 ProductGrid.vue**

- el-grid 展示商品卡片（名称 + 价格 + 图片）
- 点击商品 → addPosItem(variantId, 1)
- 懒加载：take=20，滚动到底部加载更多

- [ ] **Step 6: 创建 CategoryBar.vue**

- el-tabs 横向滚动分类
- 切换分类 → 重新查询 products（collectionId 过滤）

- [ ] **Step 7: 创建 CartPanel.vue**

- 右侧固定面板：当前 Order lines 列表
- 每行：商品名 + 单价 + 数量（+/- 按钮）+ 小计
- 底部：总金额 + "结账"按钮（跳 /checkout）
- 空购物车提示"请添加商品"

- [ ] **Step 8: 创建 CashierView.vue**

布局：左侧 CategoryBar + ProductGrid（70%），右侧 CartPanel（30%）。
顶部：当前班次信息（terminal code + operator）+ 设备状态。
扫码枪：useScanner 监听，扫码后查商品变体 → addPosItem。
快捷键：F1 跳 /checkout。

- [ ] **Step 9: 验证收银流程**

启动 server + web，登录 → 开班 → 加商品 → 查看购物车 → 改数量 → 跳结账页。

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(web): CashierView 商品查询 + 购物车 + 扫码枪"
```

---

## Task 3: CheckoutView + ShiftView（结账 + 班次管理）

**Files:**
- Create: `vcash/web/src/api/operations/aggregate-pay.graphql`
- Create: `vcash/web/src/composables/useAggregatePayPolling.ts`
- Create: `vcash/web/src/views/CheckoutView.vue`
- Create: `vcash/web/src/views/ShiftView.vue`
- Create: `vcash/web/src/components/PaymentMethodBar.vue`
- Create: `vcash/web/src/components/AggregatePayPanel.vue`

- [ ] **Step 1: 创建 aggregate-pay.graphql**

```graphql
mutation CreateAggregatePay($aggregatePayCode: String!) {
  createAggregatePay(input: { aggregatePayCode: $aggregatePayCode }) {
    id amount state method
    customFields { aggregatePayCode aggregatePayStatus }
  }
}

query AggregatePayByCode($aggregatePayCode: String!) {
  aggregatePayByCode(aggregatePayCode: $aggregatePayCode) {
    id state method
    customFields { aggregatePayStatus }
    order { id state }
  }
}

mutation ConfirmAggregatePay($paymentId: ID!) {
  confirmAggregatePay(paymentId: $paymentId) { id state }
}

mutation SettleAggregatePay($paymentId: ID!) {
  settleAggregatePay(paymentId: $paymentId) { id state }
}

mutation FailAggregatePay($paymentId: ID!) {
  failAggregatePay(paymentId: $paymentId) { id state }
}

mutation CheckoutPosOrder($payments: [CheckoutPaymentInput!]!) {
  checkoutPosOrder(input: { payments: $payments }) {
    order { id code state total totalWithTax }
    payments { id amount state method }
  }
}

mutation CloseSession($sessionId: ID!, $closingCash: Int, $approverId: ID) {
  closeSession(input: { sessionId: $sessionId, closingCash: $closingCash, approverId: $approverId }) {
    session { id state closedAt closingCash }
    summary
  }
}

query ShiftReportPreview($sessionId: ID!, $closingCash: Int) {
  shiftReportPreview(sessionId: $sessionId, closingCash: $closingCash)
}
```

- [ ] **Step 2: 创建 useAggregatePayPolling.ts**

```typescript
// composable: 轮询聚合码支付状态
// start(paymentId) → setInterval 每 2s 查 aggregatePayByCode
// state=Authorized → 自动调 settleAggregatePay → onSuccess
// state=Cancelled → onFail
// 超时 5 分钟（150 次）→ 提示收银员取消
// stop() 清理 interval
```

- [ ] **Step 3: 创建 PaymentMethodBar.vue**

两个大按钮："现金" + "聚合码"。
点击"现金" → 直接 checkoutPosOrder({ payments: [{ method: 'cash' }] }) → 成功跳小票预览。
点击"聚合码" → 显示 AggregatePayPanel。

- [ ] **Step 4: 创建 AggregatePayPanel.vue**

- 生成随机 aggregatePayCode（如 `AGG-${timestamp}`）
- 调 createAggregatePay → 拿到 paymentId
- 显示"等待客户扫码付款..." + 倒计时 5 分钟
- useAggregatePayPolling 轮询
- 成功 → settleAggregatePay → 跳小票预览
- 失败/超时 → 提示"客户未付款" + "取消订单" / "重新等待"

- [ ] **Step 5: 创建 CheckoutView.vue**

- 顶部：订单总金额（大字）
- 中部：PaymentMethodBar
- 聚合码选中时：AggregatePayPanel
- 结账成功：显示"支付成功" + 小票预览（订单明细 + 支付方式 + 金额）+ "新订单"按钮（跳 /cashier）
- 底部：返回收银台按钮（保留购物车）

- [ ] **Step 6: 创建 ShiftView.vue**

- 顶部：当前班次信息（terminal + operator + openedAt + openingFloat）
- 中部：shiftReportPreview 实时对账单
  - 订单统计：总数 + 销售额 + 退货数 + 退货额 + 挂单数
  - 支付方式明细：现金笔数/金额 + 聚合码笔数/金额
  - 现金对账：应收现金 + 实交现金输入框 + 差额 warning
- 底部："关班"按钮 → closeSession → 跳 /setup

- [ ] **Step 7: 端到端验证**

完整流程：登录 → 选 Channel → 选终端 → 开班 → 扫码加商品 → 现金结账 → 新订单 → 聚合码结账 → 关班对账 → 跳 /setup。

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(web): CheckoutView + ShiftView 结账与班次管理"
```

---

## Phase 3 完成标准

- [ ] web 脚手架 + Apollo + Element Plus + codegen 配置完成
- [ ] LoginView：username/password 登录 + Channel token 切换
- [ ] SetupView：选终端 + 开班
- [ ] CashierView：商品查询 + 购物车 + 扫码枪
- [ ] CheckoutView：现金 + 聚合码支付
- [ ] ShiftView：对账预览 + 关班
- [ ] 路由守卫：未登录/未开班/已开班正确跳转
- [ ] 端到端：登录→开班→收银→结账→关班 全流程跑通

---

## 后续 Phase 预告

- **Phase 4**: 离线能力（vcash-offline-plugin + IndexedDB + Dexie）
- **Phase 5**: 退货与挂单 UI（RefundView + 挂单取单）
- **Phase 6**: 外设集成（电子秤 + 钱箱 + ESC-POS 打印）
- **Phase 7**: 测试完善 + 部署
