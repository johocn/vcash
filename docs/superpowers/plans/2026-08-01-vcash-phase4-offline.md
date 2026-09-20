# vcash Phase 4: 离线能力 MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 实现断网可收银/退货/交班，联网自动同步。包含后端 vcash-offline-plugin（OfflineSyncQueue + 幂等 + LWW）和前端 Dexie + useOfflineSync + 网络检测 + 断网降级 UI + 商品/会员缓存增量同步。

**Architecture:** 后端新增 vcash-offline-plugin；前端 web 新增 db/dexie.ts + stores/offline.ts + composables/useOfflineSync.ts/useIncrementalSync.ts + 改造 CheckoutView/ShiftView 支持断网降级。

**Spec 参考:** `docs/superpowers/specs/2026-08-01-vcash-redesign-design.md` §5 离线同步策略、§4.4 vcash-offline-plugin Admin API

**Phase 2/3 成果:** vcash-pos-plugin 45 测试通过；web 在线收银 MVP 完成（LoginView/SetupView/CashierView/CheckoutView/ShiftView）

---

## 关键卡点与约束（Subagent 必读）

1. **插件依赖注入（核心卡点）**
   - vcash-offline-plugin 依赖 vcash-pos-plugin 的 `PosOrderService` 和 `PosSessionService`
   - 通过 Vendure PluginDependency 机制声明依赖
   - 用 `@Inject(PosOrderService)` 注入，调用其 `createPosOrder`/`addPosItem`/`checkoutPosOrder` 等方法
   - **关键设计**：离线同步与在线结账走同一套业务逻辑，避免双份实现

2. **幂等键 + LWW 冲突**
   - 前端每笔订单/支付/班次生成 `idempotencyKey`（UUID）
   - 后端 OfflineSyncQueue 实体按 idempotencyKey 唯一
   - 同步流程：
     - 已 `success` → 直接返回原结果（防止重复扣库/支付）
     - 已 `failed` + `clientUpdatedAt` 更新 → 覆盖重试（LWW）
     - 已 `failed` + `clientUpdatedAt` 更旧 → 返回 `CONFLICT` 拒绝
   - 已 success 的记录**永不覆盖**

3. **库存冲突处理**
   - 断网期间多终端各自扣库存，联网后可能超卖
   - 策略：乐观扣减 + 失败回滚 + 人工兜底
   - 同步时 addItemToOrder 抛 `Insufficient stock` → Order 转 Cancelled → 返回 `OUT_OF_STOCK` 错误码
   - 前端收到 `OUT_OF_STOCK` → 弹窗提示 + 标记订单 `syncStatus=cancelled`

4. **网络检测**
   - 前端用 `navigator.onLine` + `online`/`offline` 事件
   - 离线时：CheckoutView 写入 IndexedDB 队列，显示"已离线保存"
   - 联网时：useOfflineSync 自动触发 syncOrders/syncPayments
   - 指数退避：`min(60 * 2^n, 1800)` 秒，n=重试次数，5 次后标记 `needsManual`

5. **商品/会员缓存增量同步**
   - 后端新增 `syncProducts(since, limit)` 和 `syncMembers(since, limit)` query（返回 items + cursor）
   - 前端 Dexie 的 products/members 表存快照，`syncMeta` 表存 `last_cursor`
   - 调度：联网时每 5 分钟一次增量同步
   - 断网时 CashierView 从 IndexedDB 查商品（按条码/名称）

6. **班次离线协调**
   - 断网时关班：本地生成对账单存 IndexedDB，session.syncStatus=pending
   - 联网后同步：调 syncSessions → 后端创建 PosSession + 关联 Orders
   - 店长确认：离线时跳过，联网后补

---

## File Structure

```
vcash/packages/vcash-offline-plugin/
├── src/
│   ├── entities/
│   │   └── offline-sync-queue.entity.ts
│   ├── services/
│   │   ├── sync-queue.service.ts      # 幂等校验 + LWW + 状态机
│   │   ├── sync-order.service.ts      # 调用 PosOrderService 落库
│   │   ├── sync-payment.service.ts    # 同步 Payment
│   │   ├── sync-session.service.ts    # 同步 PosSession
│   │   └── incremental-sync.service.ts # 商品/会员增量查询
│   ├── resolvers/
│   │   └── admin-sync.resolver.ts     # syncOrders/syncPayments/syncSessions/syncProducts/syncMembers
│   ├── constants.ts                   # SYNC_STATUS 枚举
│   └── plugin.ts
├── e2e/
│   ├── sync-order.e2e-spec.ts
│   └── incremental-sync.e2e-spec.ts
├── package.json
└── tsconfig.json

vcash/web/src/
├── db/
│   └── dexie.ts                       # IndexedDB schema
├── stores/
│   └── offline.ts                     # 离线队列状态 + 网络状态
├── composables/
│   ├── useOfflineSync.ts              # 队列调度 + 指数退避
│   └── useIncrementalSync.ts          # 商品/会员增量同步
├── api/operations/
│   └── sync.graphql                   # syncOrders/syncPayments/syncSessions/syncProducts/syncMembers
└── views/
    └── CheckoutView.vue               # 改造：断网降级
```

---

## Task 1: vcash-offline-plugin 后端（OfflineSyncQueue + 幂等 + LWW + syncOrders）

**Files:**
- Create: `vcash/packages/vcash-offline-plugin/package.json`
- Create: `vcash/packages/vcash-offline-plugin/tsconfig.json`
- Create: `vcash/packages/vcash-offline-plugin/src/plugin.ts`
- Create: `vcash/packages/vcash-offline-plugin/src/constants.ts`
- Create: `vcash/packages/vcash-offline-plugin/src/entities/offline-sync-queue.entity.ts`
- Create: `vcash/packages/vcash-offline-plugin/src/services/sync-queue.service.ts`
- Create: `vcash/packages/vcash-offline-plugin/src/services/sync-order.service.ts`
- Create: `vcash/packages/vcash-offline-plugin/src/resolvers/admin-sync.resolver.ts`
- Create: `vcash/packages/vcash-offline-plugin/e2e/sync-order.e2e-spec.ts`
- Modify: `vcash/server/vendure-config.ts`（注册插件）

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@vcash/offline-plugin",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch",
    "test": "vitest run"
  },
  "peerDependencies": { "@vendure/core": "^3.6.4" },
  "devDependencies": { "@vendure/core": "^3.6.4", "typescript": "^5.5.0", "vitest": "^2.0.0" }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

extends `e:\code\vcash\packages\vcash-pos-plugin\tsconfig.json` 的模式（strict, outDir dist）。

- [ ] **Step 3: 创建 constants.ts**

```typescript
export const SYNC_STATUS = {
  PENDING: 'pending',
  SYNCING: 'syncing',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  NEEDS_MANUAL: 'needs_manual',
} as const;

export const offlineSyncPermission = {
  Read: { name: 'ReadOfflineSync', description: '查看离线同步队列' },
  Update: { name: 'UpdateOfflineSync', description: '执行离线同步操作' },
} as const;
```

- [ ] **Step 4: 创建 offline-sync-queue.entity.ts**

```typescript
import { DeepPartial } from '@vendure/common/lib/shared-types';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
@Index(['idempotencyKey'], { unique: true })
export class OfflineSyncQueue {
  constructor(input?: DeepPartial<OfflineSyncQueue>) {
    if (input) Object.assign(this, input);
  }

  @PrimaryGeneratedColumn() id: number;

  @Column({ unique: true }) idempotencyKey: string;
  @Column() type: 'order' | 'payment' | 'session';  // 队列项类型
  @Column({ type: 'json' }) payload: any;            // 客户端提交的完整数据
  @Column() clientCreatedAt: Date;
  @Column() clientUpdatedAt: Date;

  @Column({ default: 'pending' }) status: string;    // SYNC_STATUS
  @Column({ nullable: true }) syncedOrderId?: number;
  @Column({ nullable: true }) syncedOrderCode?: string;
  @Column({ nullable: true, type: 'json' }) syncError?: { code: string; message: string };
  @Column({ default: 0 }) retryCount: number;
  @Column({ nullable: true }) syncedAt?: Date;
  @Column({ nullable: true }) sessionCode?: string;  // 关联班次
}
```

- [ ] **Step 5: 创建 sync-queue.service.ts**

核心方法：
- `findExisting(idempotencyKey)` → 查已有记录
- `savePending(record)` → 新建 pending 记录
- `markSuccess(id, syncedOrderId, syncedOrderCode)` → 标记成功
- `markFailed(id, error)` → 标记失败 + retryCount++
- `isStaleVersion(clientUpdatedAt, existing)` → LWW 比较
- `markNeedsManual(id)` → retryCount > 5 时标记

- [ ] **Step 6: 创建 sync-order.service.ts**

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { RequestContext } from '@vendure/core';
import { PosOrderService } from '@vcash/pos-plugin';  // 注入 vcash-pos-plugin 的 service

@Injectable()
export class SyncOrderService {
  constructor(
    @Inject(OfflineSyncQueueService) private queueService: OfflineSyncQueueService,
    @Inject(PosOrderService) private posOrderService: PosOrderService,
  ) {}

  async syncSingleOrder(ctx: RequestContext, order: OfflineOrderRecord) {
    // 1. 幂等校验
    const existing = await this.queueService.findExisting(order.idempotencyKey);
    if (existing?.status === 'success') {
      return { idempotencyKey: order.idempotencyKey, orderId: existing.syncedOrderId,
               orderCode: existing.syncedOrderCode, status: 'duplicate' };
    }
    if (existing?.status === 'failed') {
      if (!this.queueService.isStaleVersion(order.clientUpdatedAt, existing.clientUpdatedAt)) {
        return { idempotencyKey: order.idempotencyKey, error: 'stale version',
                 code: 'CONFLICT', status: 'failed' };
      }
      await this.queueService.delete(existing.id);
    }

    // 2. 创建 pending 记录
    const queueItem = await this.queueService.savePending({
      idempotencyKey: order.idempotencyKey, type: 'order',
      payload: order, clientCreatedAt: order.clientCreatedAt,
      clientUpdatedAt: order.clientUpdatedAt, sessionCode: order.sessionCode,
    });

    // 3. 调用 PosOrderService 落库
    try {
      // 调 posOrderService 的内部方法（需在 vcash-pos-plugin 暴露）
      const newOrder = await this.posOrderService.createOrderFromOffline(ctx, order);
      await this.queueService.markSuccess(queueItem.id, newOrder.id, newOrder.code);
      return { idempotencyKey: order.idempotencyKey, orderId: newOrder.id,
               orderCode: newOrder.code, status: 'success' };
    } catch (e: any) {
      await this.queueService.markFailed(queueItem.id, { code: e.code ?? 'UNKNOWN', message: e.message });
      return { idempotencyKey: order.idempotencyKey, error: e.message,
               code: e.code ?? 'UNKNOWN', status: 'failed' };
    }
  }
}
```

**关键：vcash-pos-plugin 需暴露 `createOrderFromOffline` 方法**

在 vcash-pos-plugin 的 PosOrderService 增加方法：
```typescript
async createOrderFromOffline(ctx: RequestContext, order: OfflineOrderRecord): Promise<Order> {
  // 1. 创建 Draft Order
  // 2. 遍历 lines 调 addItemToOrder（库存不足抛 OUT_OF_STOCK）
  // 3. 调 checkoutPosOrder（支付）
  // 4. 返回 Order
}
```

- [ ] **Step 7: 创建 admin-sync.resolver.ts**

```graphql
extend type Mutation {
  syncOrders(input: SyncOrdersInput!): SyncOrdersResult!
}

input SyncOrdersInput {
  orders: [OfflineOrderInput!]!
}

input OfflineOrderInput {
  idempotencyKey: String!
  clientCreatedAt: DateTime!
  clientUpdatedAt: DateTime!
  sessionCode: String!
  terminalCode: String!
  orderType: String!
  lines: [OfflineOrderLineInput!]!
  payments: [OfflinePaymentInput!]!
  totalAmount: Int!
}

type SyncOrdersResult {
  succeeded: [SyncedOrder!]!
  failed: [SyncFailure!]!
}

type SyncedOrder {
  idempotencyKey: String!
  orderId: ID!
  orderCode: String!
}

type SyncFailure {
  idempotencyKey: String!
  error: String!
  code: String!
}
```

- [ ] **Step 8: 创建 plugin.ts**

```typescript
@VendurePlugin({
  imports: [PluginCommonModule, TypeOrmModule.forFeature([OfflineSyncQueue])],
  entities: [OfflineSyncQueue],
  providers: [OfflineSyncQueueService, SyncOrderService, SyncPaymentService, SyncSessionService],
  adminApiExtensions: { resolvers: [AdminSyncResolver], schema: adminSchema },
  dependencies: [VcashPosPlugin],  // 声明依赖
  configuration: (config) => {
    config.authOptions.customPermissions = [
      ...(config.authOptions.customPermissions ?? []),
      offlineSyncPermission.Read, offlineSyncPermission.Update,
    ];
    return config;
  },
})
export class VcashOfflinePlugin {}
```

- [ ] **Step 9: 在 server/vendure-config.ts 注册插件**

```typescript
import { VcashOfflinePlugin } from '@vcash/offline-plugin';
// ...
plugins: [
  VcashPosPlugin,
  VcashOfflinePlugin,  // 新增
  // ...
]
```

- [ ] **Step 10: 编写 e2e 测试**

`e2e/sync-order.e2e-spec.ts`：
- 测试 1：syncOrders 创建新订单 → 返回 success + orderId
- 测试 2：重复 syncOrders 同一 idempotencyKey → 返回 duplicate
- 测试 3：库存不足 → 返回 failed + OUT_OF_STOCK 错误码
- 测试 4：LWW 场景：failed + 更新 clientUpdatedAt → 重试成功

- [ ] **Step 11: 构建 + 测试 + 提交**

```bash
cd vcash/packages/vcash-offline-plugin && pnpm install && pnpm build && pnpm test
cd vcash && git add packages/vcash-offline-plugin server/vendure-config.ts && git commit -m "feat(offline-plugin): OfflineSyncQueue + syncOrders + 幂等 + LWW"
```

---

## Task 2: syncPayments + syncSessions + 增量同步 API

**Files:**
- Create: `vcash/packages/vcash-offline-plugin/src/services/sync-payment.service.ts`
- Create: `vcash/packages/vcash-offline-plugin/src/services/sync-session.service.ts`
- Create: `vcash/packages/vcash-offline-plugin/src/services/incremental-sync.service.ts`
- Modify: `vcash/packages/vcash-offline-plugin/src/resolvers/admin-sync.resolver.ts`（追加 mutation/query）
- Create: `vcash/packages/vcash-offline-plugin/e2e/incremental-sync.e2e-spec.ts`

- [ ] **Step 1: 创建 sync-payment.service.ts**

同步离线 Payment：按 orderKey 找已同步的 Order → 创建 Payment → 状态转换。

- [ ] **Step 2: 创建 sync-session.service.ts**

同步离线 PosSession：创建 PosSession + 关联已同步的 Orders + 生成 closeSummary。

- [ ] **Step 3: 创建 incremental-sync.service.ts**

```typescript
@Injectable()
export class IncrementalSyncService {
  async syncProducts(ctx: RequestContext, since: Date, limit: number) {
    // 查 updatedAt > since 的 ProductVariant，返回 items + cursor
    // 按 Channel 隔离
  }

  async syncMembers(ctx: RequestContext, since: Date, limit: number) {
    // 查 updatedAt > since 的 Customer（含 member level custom fields）
  }
}
```

- [ ] **Step 4: admin-sync.resolver.ts 追加**

```graphql
extend type Mutation {
  syncPayments(input: SyncPaymentsInput!): SyncPaymentsResult!
  syncSessions(input: SyncSessionsInput!): SyncSessionsResult!
}

extend type Query {
  syncProducts(since: DateTime!, limit: Int!): SyncProductsResult!
  syncMembers(since: DateTime!, limit: Int!): SyncMembersResult!
}

type SyncProductsResult {
  items: [ProductSnapshot!]!
  cursor: DateTime!
}

type ProductSnapshot {
  variantId: ID!
  sku: String!
  name: String!
  price: Int!
  priceWithTax: Int!
  barcode: String
  categoryId: ID
  updatedAt: DateTime!
}
```

- [ ] **Step 5: e2e 测试**

- syncProducts 增量返回更新商品 + cursor 推进
- syncMembers 同理
- syncPayments 幂等

- [ ] **Step 6: 构建 + 测试 + 提交**

```bash
git commit -m "feat(offline-plugin): syncPayments + syncSessions + 增量同步 API"
```

---

## Task 3: 前端 Dexie + useOfflineSync + 网络检测 + CheckoutView 断网降级

**Files:**
- Create: `vcash/web/src/db/dexie.ts`
- Create: `vcash/web/src/stores/offline.ts`
- Create: `vcash/web/src/composables/useOfflineSync.ts`
- Create: `vcash/web/src/composables/useIncrementalSync.ts`
- Create: `vcash/web/src/api/operations/sync.graphql`
- Modify: `vcash/web/src/views/CheckoutView.vue`（断网降级）
- Modify: `vcash/web/src/views/ShiftView.vue`（断网关班）
- Modify: `vcash/web/src/views/CashierView.vue`（断网从 IndexedDB 查商品）

- [ ] **Step 1: 创建 db/dexie.ts**

按 spec §5.2 定义 VcashDB（orders/payments/sessions/products/members/syncMeta 六张表）。

- [ ] **Step 2: 创建 api/operations/sync.graphql**

syncOrders/syncPayments/syncSessions mutations + syncProducts/syncMembers queries。

- [ ] **Step 3: 创建 stores/offline.ts**

```typescript
// Pinia store: isOnline, pendingCount, syncingCount, failedCount
// actions: detectNetwork()（监听 online/offline 事件）
//          updateCounts()（从 Dexie 统计）
//          markOrderSynced(key), markOrderFailed(key, error)
```

- [ ] **Step 4: 创建 composables/useOfflineSync.ts**

```typescript
export function useOfflineSync() {
  const offlineStore = useOfflineStore();
  const isSyncing = ref(false);

  async function syncAll() {
    if (!navigator.onLine || isSyncing.value) return;
    isSyncing.value = true;
    try {
      await syncOrders();
      await syncPayments();
      await syncSessions();
    } finally {
      isSyncing.value = false;
      offlineStore.updateCounts();
    }
  }

  async function syncOrders() {
    const pending = await db.orders.where('syncStatus').equals('pending').toArray();
    if (pending.length === 0) return;
    // 批量调 syncOrders mutation
    // 成功：更新 IndexedDB syncStatus=success + syncedOrderId
    // 失败：syncStatus=failed + retryCount++（>5 标记 needsManual）
  }

  // 监听 online 事件自动触发
  onMounted(() => {
    window.addEventListener('online', syncAll);
    if (navigator.onLine) syncAll();
  });
  onUnmounted(() => window.removeEventListener('online', syncAll));

  return { syncAll, isSyncing };
}
```

- [ ] **Step 5: 创建 composables/useIncrementalSync.ts**

```typescript
export function useIncrementalSync() {
  // 联网时每 5 分钟增量同步商品/会员到 IndexedDB
  // onMounted 启动定时器，onUnmounted 清理
  // 从 db.syncMeta 读 last_cursor，调 syncProducts/syncMembers
}
```

- [ ] **Step 6: 改造 CheckoutView.vue 断网降级**

```typescript
// 结账流程：
// if (navigator.onLine) {
//   走在线流程（调 checkoutPosOrder）
// } else {
//   离线降级：生成 idempotencyKey + 写入 db.orders + db.payments
//   显示"已离线保存，联网后自动同步"
//   清空 cart store，跳 /cashier
// }
```

- [ ] **Step 7: 改造 ShiftView.vue 断网关班**

```typescript
// 关班流程：
// if (navigator.onLine) {
//   走在线流程（调 closeSession）
// } else {
//   离线降级：本地生成对账单 + 写入 db.sessions (syncStatus=pending)
//   提示"已离线保存，联网后自动同步"
//   跳 /setup
// }
```

- [ ] **Step 8: 改造 CashierView.vue 断网查商品**

```typescript
// 商品查询：
// if (navigator.onLine) {
//   走在线流程（products query）
// } else {
//   离线降级：从 db.products 查（按 barcode/name 索引）
// }
```

- [ ] **Step 9: App.vue 启动时初始化**

```typescript
// onMounted: 初始化 offlineStore.detectNetwork() + useIncrementalSync()
```

- [ ] **Step 10: 验证 + 提交**

```bash
# 验证：启动后端 + 前端
# 1. 断网（浏览器 DevTools → Network → Offline）
# 2. 加商品 → 结账 → 显示"已离线保存"
# 3. 联网 → 自动同步 → 看到订单出现在后端
cd vcash && git add web/ && git commit -m "feat(web): Dexie + useOfflineSync + 断网降级 + 增量同步"
```

---

## Phase 4 完成标准

- [ ] vcash-offline-plugin：OfflineSyncQueue 实体 + syncOrders/syncPayments/syncSessions + 幂等 + LWW
- [ ] 增量同步 API：syncProducts/syncMembers
- [ ] 前端 Dexie schema（6 表）+ useOfflineSync + useIncrementalSync
- [ ] 网络检测：online/offline 事件 + 自动触发同步
- [ ] CheckoutView 断网降级：写入 IndexedDB 队列
- [ ] ShiftView 断网关班：本地对账单
- [ ] CashierView 断网查商品：从 IndexedDB 查
- [ ] e2e：syncOrders 幂等/LWW/库存冲突 全部通过
- [ ] 端到端：断网收银 → 联网同步 → 后端数据一致

---

## 后续 Phase 预告

- **Phase 5**: 退货与挂单 UI（RefundView + 挂单取单）
- **Phase 6**: 外设集成（电子秤 + 钱箱 + ESC-POS 打印）
- **Phase 7**: 测试完善 + 部署
