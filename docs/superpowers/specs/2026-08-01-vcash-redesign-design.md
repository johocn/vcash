# vcash 收银系统重新开发设计

> 基于 Odoo `zhao_market_pos` 业务蓝本，后端切换为 Vendure，多租户多仓库，从零独立项目实现。

- 创建日期：2026-08-01
- 状态：Spec（已评审修订 v2）
- 源参考：`e:\code\odoo\custom-addons\zhao_market_pos`（Odoo 19 + Vue3 POS 收银台）
- 目标目录：`e:\code\vcash`（独立项目，不存在 Odoo 残留）

---

## 1. 任务背景与目标

### 1.1 背景

`zhao_market_pos` 是 Odoo 19 + Vue3 实现的中国本地化超市 POS 收银台，核心特性包括扫码枪、快捷键矩阵、挂单取单、会员价/等级折扣、聚合码支付、交班对账单、浏览器小票打印。但存在以下问题：

- 依赖 Odoo 原生模型（point_of_sale/product/stock/zhao_member/zhao_pos_shift），升级复杂
- 无离线兜底，断网即收银停业
- 仅支持扫码枪与浏览器原生打印，外设能力不足
- 多租户依赖 Odoo 多公司机制，非电商原生

### 1.2 目标

在 `e:\code\vcash` 下从零构建独立项目：

- 后端：Vendure（复用 `@vendure/core` + `@vendure/member-level-plugin` + `@vendure/cjk-plugin`）
- 多租户：Channel = 租户（连锁品牌），StockLocation = 门店
- 多仓库：一租户多门店，商品共享库存隔离
- 全离线：断网可收银/退货/交班，联网自动同步
- 全外设：扫码枪（HID）+ 电子秤（WebSerial）+ 钱箱（WebUSB）+ ESC-POS 打印（WebUSB/WebSerial）
- 前端参考重写：保留业务流程与 UI 设计，类型系统按 Vendure 模型重建，**无 Odoo 残留**

### 1.3 关键决策汇总

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 前端复用边界 | 参考重写 | 用户要求"不要有 odoo 残留" |
| 多租户多仓库语义 | 一租户多门店 | Channel=品牌，StockLocation=门店 |
| 支付方案 | 聚合码贴纸 | 零资质零成本，沿用 Odoo 模式 |
| 会员体系 | 复用 member-level-plugin | 已有等级/积分，扩展商品级折扣 |
| 交班流程 | 简化两态（open/closed），可选店长确认 | 门店场景不需完整四步 |
| 部署形态 | 独立项目 | 与 vendure 解耦，依赖以 npm 装 |
| 离线能力 | 全离线 | 零售 POS 断网即停业是致命问题 |
| 商品库存隔离 | 商品共享、库存隔离 | Vendure 原生模式 |
| 外设范围 | 扫码枪 + 电子秤 + 钱箱 + ESC-POS | 完整覆盖中大型超市 |
| 退货与多终端 | 都在 MVP | 退货是核心场景，多终端覆盖多 POS |
| 架构方案 | 方案 B（领域分层多插件） | vcash-pos-plugin + vcash-offline-plugin |
| 收银员账号体系 | Administrator + Admin API | 收银员是店员非顾客，需 Role/Permission 体系 |
| 商品级会员价 | 按 variant × level 矩阵 | 不同等级对应不同会员价 |

---

## 2. 整体架构

### 2.1 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                    vcash/web  (Vue3 + Pinia SPA)                     │
│                                                                     │
│  views: CashierView / CheckoutView / RefundView / ShiftView / Setup │
│  composables: useScanner / useWeightScale / useCashDrawer /         │
│               useEscposPrinter / useOfflineSync / usePosSession      │
│  stores: cart / payment / pending / session / offline               │
│  api: graphql-client.ts (Apollo) + codegen 类型                     │
│                                                                     │
│  离线层: IndexedDB (Dexie) ── 订单/支付队列 + 商品/会员快照缓存     │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ GraphQL over HTTP (vendure-token header)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Vendure 后端 (vcash/server)                       │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │ vcash-pos-plugin (POS 业务核心)                          │      │
│  │  - PosTerminal / PosSession 实体                         │      │
│  │  - Order custom fields (posSessionId, orderType,         │      │
│  │    refundedOrderId, shiftId, terminalCode,               │      │
│  │    aggregatePayStatus)                                   │      │
│  │  - OrderLine custom fields (originalPrice, discount,     │      │
│  │    memberPriceApplied, isGift, note)                     │      │
│  │  - 聚合码支付状态机 (pending → confirmed → settled)       │      │
│  │  - 交班对账单生成                                          │      │
│  │  - GraphQL admin+shop resolvers                          │      │
│  └──────────────────────────────────────────────────────────┘      │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │ vcash-offline-plugin (离线同步队列)                      │      │
│  │  - OfflineSyncQueue 实体 (idempotencyKey, payload,       │      │
│  │    status, retryCount, lastError)                        │      │
│  │  - syncOrders / syncPayments mutations                   │      │
│  │  - 幂等键 + LWW 冲突策略                                  │      │
│  │  - EventBus 事件桥                                        │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                     │
│  复用生态:                                                           │
│  - @vendure/core (Order/StockLocation/Channel/Customer)             │
│  - @vendure/member-level-plugin (会员等级/积分, 扩展商品级折扣)     │
│  - @vendure/cjk-plugin (多租户增强: Channel custom fields)          │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 多租户 / 多仓库映射

| 概念 | Vendure 实体 | 隔离粒度 |
|------|--------------|---------|
| 租户（连锁品牌） | Channel | 商品目录/定价/支付方式/促销独立 |
| 门店（仓库） | StockLocation（属于 Channel） | 库存数隔离，商品共享 |
| POS 终端 | PosTerminal（Channel + StockLocation 双绑定） | 一终端绑一门店 |
| 班次 | PosSession（PosTerminal + 操作员 + 时段） | 一终端同时仅一个 open session |

### 2.3 目录结构

```
e:\code\vcash\
├── packages/
│   ├── vcash-pos-plugin/          # POS 业务核心插件
│   │   ├── src/
│   │   │   ├── entities/
│   │   │   │   ├── pos-terminal.entity.ts
│   │   │   │   └── pos-session.entity.ts
│   │   │   ├── custom-fields/
│   │   │   │   ├── order-custom-fields.ts
│   │   │   │   └── order-line-custom-fields.ts
│   │   │   ├── services/
│   │   │   │   ├── pos-session.service.ts
│   │   │   │   ├── pos-order.service.ts
│   │   │   │   ├── aggregate-pay.service.ts
│   │   │   │   └── shift-report.service.ts
│   │   │   ├── resolvers/
│   │   │   │   ├── admin-pos.resolver.ts
│   │   │   │   └── shop-pos.resolver.ts
│   │   │   ├── event-handlers/
│   │   │   │   └── order-state-listener.ts
│   │   │   ├── plugin.ts
│   │   │   └── types.ts
│   │   ├── e2e/
│   │   │   └── pos-flow.e2e-spec.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── vcash-offline-plugin/      # 离线同步队列插件
│       ├── src/
│       │   ├── entities/
│       │   │   └── offline-sync-queue.entity.ts
│       │   ├── services/
│       │   │   ├── sync-queue.service.ts
│       │   │   └── conflict-resolver.service.ts
│       │   ├── resolvers/
│       │   │   └── shop-sync.resolver.ts
│       │   ├── strategies/
│       │   │   ├── idempotency.ts
│       │   │   └── lww.ts
│       │   └── plugin.ts
│       ├── e2e/
│       │   └── offline-sync.e2e-spec.ts
│       └── package.json
│
├── web/                           # POS 前端 SPA
│   ├── src/
│   │   ├── views/
│   │   │   ├── CashierView.vue
│   │   │   ├── CheckoutView.vue
│   │   │   ├── RefundView.vue
│   │   │   ├── ShiftView.vue
│   │   │   └── SetupView.vue
│   │   ├── components/
│   │   │   ├── CartPanel.vue
│   │   │   ├── ProductGrid.vue
│   │   │   ├── CategoryBar.vue
│   │   │   ├── PaymentMethodBar.vue
│   │   │   ├── AggregatePayPanel.vue
│   │   │   ├── MemberInput.vue
│   │   │   ├── ReceiptTemplate.vue
│   │   │   ├── WeightInputDialog.vue
│   │   │   ├── InvoiceRequestDialog.vue
│   │   │   └── DeviceStatusBadge.vue
│   │   ├── composables/
│   │   │   ├── useScanner.ts         # HID 扫码枪
│   │   │   ├── useWeightScale.ts     # WebSerial 电子秤
│   │   │   ├── useCashDrawer.ts      # WebUSB 钱箱
│   │   │   ├── useEscposPrinter.ts   # WebUSB/WebSerial ESC-POS
│   │   │   ├── useOfflineSync.ts     # 离线队列调度
│   │   │   ├── usePosSession.ts      # 班次生命周期
│   │   │   ├── useMemberCache.ts     # 会员快照
│   │   │   ├── useIncrementalSync.ts # 商品/会员增量同步
│   │   │   ├── useShortcut.ts        # F1-F12 快捷键
│   │   │   └── useLabelPrinter.ts
│   │   ├── stores/
│   │   │   ├── cart.ts
│   │   │   ├── payment.ts
│   │   │   ├── session.ts
│   │   │   ├── pending.ts            # 聚合码待确认支付
│   │   │   └── offline.ts            # IndexedDB 队列状态
│   │   ├── api/
│   │   │   ├── graphql-client.ts     # Apollo 客户端 + vendure-token 注入
│   │   │   ├── operations/           # .graphql 查询文件
│   │   │   └── types.ts              # codegen 产物
│   │   ├── db/
│   │   │   └── dexie.ts              # IndexedDB schema
│   │   ├── types/
│   │   │   └── index.ts              # 领域类型（Vendure 模型对齐）
│   │   ├── utils/
│   │   │   ├── format.ts             # 价格/日期格式化
│   │   │   ├── idempotency.ts        # UUID 生成
│   │   │   └── receipt-builder.ts    # 票据数据构建
│   │   ├── App.vue
│   │   ├── main.ts
│   │   └── router.ts
│   ├── e2e/
│   │   └── cashier-flow.spec.ts
│   ├── vite.config.ts
│   ├── codegen.ts
│   ├── package.json
│   └── tsconfig.json
│
├── server/                        # Vendure 实例入口
│   ├── vendure-config.ts          # 注册所有插件 + 配置
│   ├── populate.ts                # 测试数据填充
│   └── package.json
│
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-08-01-vcash-redesign-design.md  # 本设计文档
│
├── package.json                   # workspace root (pnpm workspace)
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md
```

### 2.4 关键架构决策

1. **前后端物理隔离**：`web/` 与 `server/` 独立 package.json，前端构建产物由 server 静态托管或独立 Nginx 部署
2. **插件按领域分**：POS 业务（同步在线）与离线同步（异步队列）分属不同插件，独立测试演进
3. **外设零后端**：扫码枪/电子秤/钱箱/ESC-POS 全前端实现，后端不感知外设
4. **复用边界清晰**：`@vendure/member-level-plugin` 与 `@vendure/cjk-plugin` 作为 npm 依赖装在 `server/package.json`，vcash 不修改它们源码；如需扩展（如商品级折扣），在 `vcash-pos-plugin` 内用 Vendure custom fields 扩展
5. **vcash 独立项目**：与 `e:\code\vendure` 解耦，`@vendure/*` 通过 npm 安装，未来 vendure 升级不影响 vcash 源码

---

## 3. 数据模型

### 3.1 实体关系

```
Channel (租户=连锁品牌)
  │
  ├── 1:N ── StockLocation (门店=仓库)
  │            │
  │            └── 1:N ── PosTerminal (POS 终端)
  │                          │
  │                          └── 1:N ── PosSession (班次)
  │                                        │
  │                                        └── 1:N ── Order (Vendure Core)
  │                                                     │
  │                                                     └── 1:N ── OrderLine (Vendure Core)
  │
  ├── 1:N ── Product / ProductVariant (商品目录共享)
  ├── 1:N ── Customer (会员, member-level-plugin 扩展)
  └── 1:N ── PaymentMethod (含聚合码支付方式)

Order 1:1 RefundOrder (通过 custom field refundedOrderId 自关联)
```

### 3.2 PosTerminal 实体

```typescript
@Entity()
@ChannelAware()
export class PosTerminal {
  @PrimaryGeneratedColumn() id: number;
  @Column() code: string;              // 终端编号 "POS-001"
  @Column() name: string;              // 显示名 "1号收银台"
  @ManyToOne(() => Channel)
  channel: Channel;                    // 所属租户
  @ManyToOne(() => StockLocation)
  stockLocation: StockLocation;        // 绑定门店（多仓库核心）
  @Column({ default: true }) active: boolean;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
  
  // 外设配置（仅作型号参考，浏览器授权不能跨浏览器复用）
  @Column({ type: 'jsonb', nullable: true })
  deviceConfig: {
    printerVendorId?: string;
    printerProductId?: string;
    scaleBaudRate?: number;
    scaleProtocol?: 'continuous' | 'polling';
    cashDrawerViaPrinter?: boolean;
    paperWidth?: 58 | 80;
  };
}
```

### 3.3 PosSession 实体（简化两态）

```typescript
@Entity()
@ChannelAware()
export class PosSession {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;  // 班次号 "S20260801-001"
  
  @ManyToOne(() => PosTerminal)
  terminal: PosTerminal;
  @ManyToOne(() => StockLocation)
  stockLocation: StockLocation;        // 冗余存快照
  @ManyToOne(() => Administrator)
  operator: Administrator;             // 收银员（Administrator，走 Admin API）
  @ManyToOne(() => Administrator, { nullable: true })
  approver: Administrator;             // 店长确认人（可选）
  
  @Column({ type: 'varchar', default: 'open' })
  state: 'open' | 'closed';            // 简化两态
  
  @Column({ type: 'timestamptz' }) openedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) closedAt: Date;
  
  @Column({ type: 'jsonb', nullable: true })
  closeSummary: ShiftSummary | null;   // 关闭时生成的对账单快照
  
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  openingFloat: number;                // 开班备用金
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  closingCash: number;                 // 实交现金（关闭时填）
  
  @Column({ nullable: true }) activeOrderId: number;  // 当前活跃 Draft Order ID
  
  // 唯一约束: 一终端同时仅一个 open 状态 session
  // 通过 partial unique index: UNIQUE (terminal_id, state) WHERE state = 'open'
}

interface ShiftSummary {
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
```

**店长确认策略**：通过 Channel custom field `requireShiftApproval: boolean`（cjk-plugin 扩展）控制。`false` 时收银员可直接关闭；`true` 时关闭需传 `approverId`，由店长账号调用 close mutation。

### 3.4 Order custom fields

```typescript
export const orderCustomFields: CustomField[] = [
  { name: 'posSessionId', type: 'int', nullable: true, description: '关联班次' },
  { name: 'orderType', type: 'string', nullable: false, default: 'sale',
    options: [{ value: 'sale' }, { value: 'refund' }, { value: 'hold' }] },
  { name: 'refundedOrderId', type: 'int', nullable: true, description: '退货单关联的原销售单 ID' },
  { name: 'shiftId', type: 'int', nullable: true, description: '冗余 shift_id 便于按班次查询' },
  { name: 'terminalCode', type: 'string', nullable: true, description: '下单终端编号快照' },
  { name: 'aggregatePayStatus', type: 'string', nullable: true,
    options: [{ value: 'pending' }, { value: 'confirmed' }, { value: 'settled' }, { value: 'failed' }] },
];
```

### 3.5 OrderLine custom fields

```typescript
export const orderLineCustomFields: CustomField[] = [
  { name: 'originalPrice', type: 'int', nullable: false, description: '原价（分）' },
  { name: 'discount', type: 'int', nullable: false, default: 100, description: '折扣率 100=原价 88=88折' },
  { name: 'memberPriceApplied', type: 'boolean', default: false },
  { name: 'isGift', type: 'boolean', default: false },
  { name: 'note', type: 'string', nullable: true },
];
```

折扣率与会员价都存 OrderLine custom field，订单总价由 Vendure Core 计算（OrderLine 单价=折后价）。退货单通过复制原 OrderLine + 负数量实现。

### 3.6 聚合码支付状态机

```
[顾客扫码输入金额]
       │
       ▼
   pending ── 收银员点"确认收款" ──► confirmed ── 交班结算 ──► settled
       │                                          │
       │ 超时 5 分钟                              │ 退款
       ▼                                          ▼
   failed                                     refunded
```

实现方式：扩展 Vendure `Payment` 实体的 custom fields（`aggregatePayCode`、`aggregatePayStatus`），不新建 PaymentMethod，复用 Vendure 原生 Payment 状态机。PaymentMethod 配置 type=`aggregate`。

**超时检测**：用 Vendure JobQueue 注册定时任务，每分钟扫描 `aggregatePayStatus=pending` 且创建时间超过 5 分钟的 Payment，标记为 `failed`。前端轮询支付状态时感知到 failed 后弹窗提示收银员。

### 3.7 ProductVariantMemberPrice 实体（商品级会员价，按等级矩阵）

```typescript
@Entity()
export class ProductVariantMemberPrice {
  @PrimaryGeneratedColumn() id: number;
  @ManyToOne(() => ProductVariant)
  variant: ProductVariant;
  @ManyToOne(() => MemberLevel)  // member-level-plugin 的等级实体
  level: MemberLevel;
  @Column({ type: 'int' }) price: number;  // 会员价（分）
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
  
  // 唯一约束: UNIQUE (variant_id, level_id)
}
```

**折扣计算优先级**：
1. 查 `ProductVariantMemberPrice` 表（variant × 当前会员 level），命中则用此价
2. 未命中则用会员等级折扣率（member-level-plugin 的 `MemberLevel.discountRate`）乘以原价
3. 无会员则原价

**离线缓存**：增量同步 `syncProducts` 时，每个 variant 携带 `memberPrices: [{ levelId, price }]` 数组，存入 IndexedDB products 表。

### 3.8 Channel / StockLocation 绑定策略

| 操作 | 绑定方式 | 备注 |
|------|---------|------|
| 商品可售范围 | Channel 级（Vendure 原生） | 所有门店共享商品目录 |
| 商品定价 | Channel 级（ProductVariantPrice） | 全门店统一价 |
| 库存数 | StockLocation 级（StockLevel，Vendure 原生） | 各门店独立扣减 |
| POS 下单扣库 | Order.stockLocationCode = 终端绑定的 StockLocation.code | Vendure 原生支持 |
| 多终端并发 | 各自 Draft Order + 各自 stockLocationCode | Vendure 原生并发安全（行锁） |
| 退货回库 | 退货 Order 的 stockLocationCode 同原单 | 自动回原门店库存 |

**关键**：不新建任何库存表，完全用 Vendure 原生 `StockMovement`（SALE/RETURN/CORRECTION）+ `Order.stockLocationCode`。

### 3.9 多终端并发与挂单

- **多终端并发**：每个 POS 终端开班后创建 Draft Order（Vendure `Order.active=true`），加商品即 `addItemToOrder`。不同终端的 Draft Order 互不影响。结账时状态转换 `AddingItems → ArrangingPayment → PaymentAuthorized → PaymentSettled`。
- **挂单**：Draft Order 的 custom field `orderType='hold'`。前端按 orderType 过滤显示挂单列表。取单时前端把该 Order 加载到 cart store，结账后 `orderType='sale'`。**挂单归属校验**：取单 mutation 校验目标 Order 的 `posSessionId.terminalId` 必须等于当前调用者 session 的 terminalId，防止跨终端误取。
- **并发安全**：同终端二次开班被 partial unique index 阻止；同 Draft Order 多终端操作通过 Vendure 原生 Order 乐观锁（`Order.version` 字段）保护。
- **活跃 Order 管理**：PosSession.activeOrderId 字段记录当前 Draft Order ID（开班时创建空 Draft Order，结账后置空并新建下一个）。POS 全部 Order 操作通过 Admin API + Administrator 鉴权，不走 Shop API 的 active order 机制。

### 3.10 退货与退款实现

**退货流程**：
1. 收银员输入原单号查询原 Order（Admin API `sessionOrders` 或按 code 查）
2. 选择退货商品行 + 退货数量
3. 调 `createRefundOrder` mutation，服务端创建 `orderType=refund` 的 Order
4. 退款单 OrderLine 复制原单行（productVariantId/单价/折扣），数量为负
5. 退货 Order 的 `stockLocationCode` 同原单，Vendure StockMovement 自动回库
6. 退款 Payment 记录（负金额）

**退款支付方式**：
- **现金退款**：创建 Payment（method=cash, amount=负数, state=Settled），前端触发钱箱打开
- **聚合码退款**：MVP 阶段不接支付 API，Payment 标记 `aggregatePayStatus=refunded` + custom field `needsManualRefund=true`，提示收银员"需在支付平台手动退款"
- **原路退回**（后续）：接微信/支付宝退款 API 后实现

**退货单与原单关联**：退货 Order 的 custom field `refundedOrderId` 指向原单 ID。原单可通过此字段反查所有关联退货单，计算实际净销售。

---

## 4. GraphQL API 与插件职责

### 4.1 插件职责矩阵

| 能力 | vcash-pos-plugin | vcash-offline-plugin | member-level-plugin | Vendure Core | cjk-plugin |
|------|------------------|----------------------|----------------------|--------------|------------|
| PosTerminal CRUD | ✓ | | | | |
| PosSession 生命周期 | ✓ | | | | |
| Order/OrderLine custom fields | ✓（声明） | | | 持久化 | |
| 聚合码支付状态机 | ✓ | | | Payment 持久化 | |
| 交班对账单生成 | ✓ | | | | |
| 退货单创建 | ✓ | | | Order 状态转换 | |
| 离线订单同步 | | ✓ | | Order 创建 | |
| 离线支付同步 | | ✓ | | Payment 创建 | |
| 冲突解决（LWW + 幂等） | | ✓ | | | |
| 会员等级折扣 | | | ✓（已有） | Customer 持久化 | |
| 商品级会员折扣 | ✓（custom fields） | | | ProductVariant 持久化 | |
| Channel 多租户策略 | | | | Channel 原生 | ✓（custom fields） |
| StockLocation 多仓库 | | | | ✓（原生） | |
| 库存扣减/回库 | | | | ✓（StockMovement） | |

### 4.2 vcash-pos-plugin Admin API

```graphql
extend type Query {
  posTerminals(options: PosTerminalListOptions): PosTerminalList!
  posTerminal(id: ID!): PosTerminal
  
  posSessions(options: PosSessionListOptions): PosSessionList!
  posSession(id: ID!): PosSession
  openPosSessions(terminalId: ID!): [PosSession!]!
  
  shiftReportPreview(sessionId: ID!): ShiftSummary!
}

extend type Mutation {
  createPosTerminal(input: CreatePosTerminalInput!): PosTerminal!
  updatePosTerminal(input: UpdatePosTerminalInput!): PosTerminal!
  deletePosTerminal(id: ID!): DeletionResponse!
  
  openPosSession(input: OpenPosSessionInput!): PosSession!
  closePosSession(input: ClosePosSessionInput!): PosSession!
  
  createRefundOrder(input: CreateRefundOrderInput!): RefundOrderResult!
  
  confirmAggregatePayment(paymentId: ID!): Payment!
  
  holdOrder(orderId: ID!): Order!
  resumeOrder(orderId: ID!): Order!
}

type PosTerminal {
  id: ID!
  code: String!
  name: String!
  channel: Channel!
  stockLocation: StockLocation!
  active: Boolean!
  sessions: [PosSession!]!
}

type PosSession {
  id: ID!
  code: String!
  terminal: PosTerminal!
  stockLocation: StockLocation!
  operator: User!
  approver: User
  state: PosSessionState!
  openedAt: DateTime!
  closedAt: DateTime
  openingFloat: Decimal!
  closingCash: Decimal!
  closeSummary: ShiftSummary
  orders: [Order!]!
}

enum PosSessionState { open closed }

type ShiftSummary {
  orders: ShiftOrderStats!
  paymentsByMethod: [ShiftPaymentStat!]!
  warnings: [String!]!
}

type ShiftOrderStats {
  totalCount: Int!
  totalAmount: Decimal!
  normalCount: Int!
  refundCount: Int!
  refundAmount: Decimal!
  heldCount: Int!
}

type ShiftPaymentStat {
  method: String!
  count: Int!
  amount: Decimal!
}
```

### 4.3 vcash-pos-plugin Admin API（POS 收银操作）

> **关键决策**：POS 收银员是店员（Administrator），不是顾客（Customer）。所有 POS 收银操作走 Admin API，鉴权用 Administrator token + Role/Permission 体系。不走 Shop API 的 active order 机制，PosSession 自己管理活跃 Order（activeOrderId 字段）。

```graphql
extend type Query {
  # 当前 Administrator 的活跃班次
  myPosSession: PosSession
  
  # 商品查询（按 Channel 自动隔离，支持条码/分类/名称）
  posProducts(options: PosProductListOptions!): PosProductList!
  
  # 会员查询（手机号/会员卡号）
  posMember(query: String!): PosMember
  
  # 挂单列表（当前 session 内 orderType=hold 的订单，含归属校验）
  heldOrders: [Order!]!
  
  # 班次内所有订单（交班对账用）
  sessionOrders(sessionId: ID!): [Order!]!
  
  # 聚合码支付状态查询（前端轮询）
  aggregatePayStatus(paymentId: ID!): Payment!
}

extend type Mutation {
  # 开班（前端调用，传入 terminalCode + openingFloat）
  openSession(input: OpenSessionInput!): PosSession!
  
  # 关班
  closeSession(input: CloseSessionInput!): CloseSessionResult!
  
  # 加商品到当前活跃 Draft Order（自动注入 stockLocationCode）
  addPosItem(input: AddPosItemInput!): Order!
  
  # 修改行（数量/折扣/赠品）
  updatePosItem(input: UpdatePosItemInput!): Order!
  
  # 结账（封装 transitionToState + settlePayment）
  checkoutPosOrder(input: CheckoutPosOrderInput!): CheckoutResult!
  
  # 聚合码: 创建待确认支付
  createPendingAggregatePay(input: CreatePendingPayInput!): Payment!
  
  # 聚合码: 收银员手点确认
  confirmAggregatePay(paymentId: ID!): Payment!
  
  # 挂单/取单（含归属校验：只能取本终端挂单）
  holdOrder(orderId: ID!): Order!
  resumeOrder(orderId: ID!): Order!
  
  # 退货（创建 orderType=refund 的 Order）
  createRefundOrder(input: CreateRefundOrderInput!): RefundOrderResult!
}

type PosProduct {
  id: ID!
  variantId: ID!
  name: String!
  barcode: String
  sku: String!
  price: Decimal!                # Channel 定价
  category: PosCategory
  uom: String                    # 单位（件/kg）
  isWeighted: Boolean!
  stockLevel: Int!               # 当前门店库存（按 StockLocation 查）
  memberPrices: [VariantMemberPrice!]!  # 按等级的会员价列表
}

type VariantMemberPrice {
  levelId: ID!
  levelName: String!
  price: Decimal!
}

type PosMember {
  customerId: ID!
  name: String!
  mobile: String!
  level: MemberLevel!
  discountRate: Int!             # 等级折扣 88=88折
}

type CloseSessionResult {
  session: PosSession!
  summary: ShiftSummary!
}

type CheckoutResult {
  order: Order!
  payments: [Payment!]!
  receiptData: ReceiptData!      # 直接返回票据数据供前端打印
}
```

### 4.4 vcash-offline-plugin Admin API

```graphql
extend type Mutation {
  syncOrders(input: SyncOrdersInput!): SyncOrdersResult!
  syncPayments(input: SyncPaymentsInput!): SyncPaymentsResult!
  syncSessions(input: SyncSessionsInput!): SyncSessionsResult!
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

### 4.5 增量同步 Admin API

```graphql
extend type Query {
  syncProducts(since: DateTime!, limit: Int = 500): SyncProductsResult!
  syncMembers(since: DateTime!, limit: Int = 500): SyncMembersResult!
}

type SyncProductsResult {
  items: [PosProduct!]!
  cursor: DateTime!
  hasMore: Boolean!
}
```

### 4.6 插件依赖关系

```
vcash-offline-plugin
       │ depends on (inject PosOrderService)
       ▼
vcash-pos-plugin
       │ depends on (Customer custom fields, MemberLevelService)
       ▼
@vendure/member-level-plugin
       │ depends on
       ▼
@vendure/core + @vendure/cjk-plugin
```

`server/vendure-config.ts` 注册顺序：

```typescript
plugins: [
  DefaultShopPlugin, DefaultAdminPlugin,
  CjkPlugin,
  MemberLevelPlugin,
  VcashPosPlugin,
  VcashOfflinePlugin,
  AssetServerPlugin, EmailPlugin,
]
```

**关键设计**：vcash-offline-plugin 不直接操作 Order 表，而是调用 vcash-pos-plugin 暴露的 `PosOrderService`（通过 Vendure Dependency Injection 注入）。离线同步与在线结账走同一套业务逻辑，避免双份实现。

### 4.7 鉴权与权限模型

> **关键变更**：POS 收银操作全部走 Admin API，收银员用 Administrator 账号 + Role/Permission 体系鉴权。

| API | 调用方 | 鉴权 | 权限标识 |
|-----|-------|------|---------|
| Admin posTerminals/sessions CRUD | 店长/管理员 | Admin API + Channel 限定 | `PosTerminal.Read/Create/Update/Delete`, `PosSession.Read/Close` |
| Admin POS 收银操作（openSession/addPosItem/checkoutPosOrder 等） | 收银员 | Admin API + Administrator | `PosSession.Open/Close`, `PosOrder.AddItem/Checkout`, `PosProduct.Read`, `PosMember.Read` |
| Admin createRefundOrder | 店长/收银员 | Admin API | `Order.Refund.Create` |
| Admin syncOrders/syncPayments | 收银员 | Admin API + 活跃 session | `PosOrder.Sync` |
| Admin syncProducts/syncMembers | 收银员 | Admin API + 活跃 session | `PosProduct.Sync`, `PosMember.Sync` |

**关键约束**：
1. 所有 POS 操作都要求当前 Administrator 有活跃 PosSession（中间件校验），防止跳过开班直接收银
2. Administrator 通过 Role 绑定 Channel（cjk-plugin 提供），收银员只能操作自己 Channel 的数据
3. 前端登录后选择 terminalCode，服务端校验该 terminal 属于当前 Administrator 的 Channel

**Administrator Role 定义**：
- `cashier`（收银员）：PosSession.Open/Close, PosOrder.*, PosProduct.Read, PosMember.Read
- `shift-manager`（店长）：cashier 权限 + PosSession.Approve, Order.Refund.Create
- `tenant-admin`（租户管理员）：全部权限 + PosTerminal.*, PosSession.*

---

## 5. 离线同步策略

### 5.1 离线场景边界

| 场景 | 离线可做 | 离线不可做 |
|------|---------|-----------|
| 收银加商品 | ✓（用本地商品缓存） | 新商品/改价实时同步 |
| 会员价折扣 | ✓（用本地会员缓存） | 新会员注册/等级变更 |
| 库存查询 | ✗（下单乐观扣减） | 实时库存校验 |
| 创建订单 | ✓（写入 IndexedDB 队列） | - |
| 聚合码支付 | ✓（订单+payment 入队列） | - |
| 退货 | ✓（需本地有原单缓存或手动输入原单号） | - |
| 结账完成 | ✓（前端视为成功，后台异步落库） | - |
| 交班 | ✓（本地生成对账单，关闭时一并同步） | 店长在线确认（离线时跳过，联网后补） |
| 班次开/关 | ✓（终端本地状态机） | - |
| 会员识别 | ✓（本地缓存查询） | 本地未命中时提示"按非会员处理或联网" |
| 退货退款 | ✓（现金退款直接从钱箱出，记录入队列） | 聚合码原路退回（MVP 标记"需人工退款"） |

**核心原则**：断网时收银不中断，所有"事务"在前端 IndexedDB 内闭环完成；联网后按队列顺序同步到后端，后端做幂等校验和库存校验。

### 5.2 IndexedDB Schema（Dexie）

```typescript
export class VcashDB extends Dexie {
  orders!: Table<OfflineOrderRecord, string>;
  payments!: Table<OfflinePaymentRecord, string>;
  sessions!: Table<OfflineSessionRecord, string>;
  products!: Table<ProductSnapshot, number>;
  members!: Table<MemberSnapshot, string>;
  syncMeta!: Table<SyncMeta, string>;

  constructor() {
    super('vcash-pos');
    this.version(1).stores({
      orders: 'idempotencyKey, sessionCode, clientCreatedAt, syncStatus',
      payments: 'idempotencyKey, orderKey, method, syncStatus',
      sessions: 'code, terminalCode, state, openedAt',
      products: 'variantId, barcode, categoryId, updatedAt',
      members: 'mobile, memberId, levelId, updatedAt',
      syncMeta: 'key',
    });
  }
}

interface OfflineOrderRecord {
  idempotencyKey: string;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  sessionCode: string;
  terminalCode: string;
  orderType: 'sale' | 'refund' | 'hold';
  refundedOrderKey?: string;
  lines: OfflineOrderLine[];
  payments: OfflinePaymentRef[];
  totalAmount: number;
  syncStatus: 'pending' | 'syncing' | 'success' | 'failed';
  syncError?: string;
  syncedOrderId?: number;
  retryCount?: number;
}

interface OfflinePaymentRecord {
  idempotencyKey: string;
  orderKey: string;
  method: 'cash' | 'wechat' | 'alipay' | 'mixed';
  amount: number;
  aggregatePayCode?: string;
  aggregatePayStatus?: 'pending' | 'confirmed' | 'settled' | 'failed';
  clientCreatedAt: string;
  syncStatus: 'pending' | 'syncing' | 'success' | 'failed';
}

interface OfflineSessionRecord {
  code: string;
  terminalCode: string;
  state: 'open' | 'closed';
  openedAt: string;
  closedAt?: string;
  openingFloat: number;
  closingCash?: number;
  localSummary?: ShiftSummary;
  syncStatus: 'pending' | 'success' | 'failed';
}
```

### 5.3 同步状态机

```
pending ──(队列触发)──► syncing ──(HTTP 成功)──► success
   │                       │
   │                       │ HTTP 失败/超时
   │                       ▼
   │                    failed
   │                       │
   │                    (指数退避重试 ≤ 5 次)
   │                       │
   └───────────────────────┘

failed 超过 5 次 → 标记 needsManual, 进人工处理队列
```

**重试策略**：指数退避 `min(60 * 2^n, 1800)` 秒，n=重试次数。重试 5 次仍失败的订单标记 `needsManual`，前端弹窗提示收银员手动处理。

### 5.4 幂等键设计

```typescript
function genIdempotencyKey(prefix: 'order' | 'payment' | 'session') {
  return `${prefix}_${uuidv4()}`;
}
```

**幂等校验流程**：

```typescript
async syncSingleOrder(order: OfflineOrderRecord, ctx: RequestContext) {
  const existing = await this.queueRepo.findOne({
    idempotencyKey: order.idempotencyKey
  });
  
  if (existing) {
    // 已成功: 直接返回原结果（防止重复支付/扣库）
    if (existing.status === 'success') {
      return { idempotencyKey: order.idempotencyKey, orderId: existing.orderId,
               orderCode: existing.orderCode, status: 'duplicate' };
    }
    // 已失败 + 新提交 clientUpdatedAt > existing.clientUpdatedAt: 覆盖重试 (LWW)
    if (existing.status === 'failed' && 
        new Date(order.clientUpdatedAt) > new Date(existing.clientUpdatedAt)) {
      await this.queueRepo.delete(existing.id);
    } else {
      return { idempotencyKey: order.idempotencyKey, error: 'stale version',
               code: 'CONFLICT', status: 'failed' };
    }
  }
  
  try {
    const newOrder = await this.posOrderService.createPosOrder(ctx, order);
    await this.queueRepo.save({
      idempotencyKey: order.idempotencyKey,
      clientCreatedAt: order.clientCreatedAt,
      clientUpdatedAt: order.clientUpdatedAt,
      payload: order,
      status: 'success',
      orderId: newOrder.id,
      syncedAt: new Date(),
    });
    return { idempotencyKey: order.idempotencyKey, orderId: newOrder.id,
             orderCode: newOrder.code, status: 'success' };
  } catch (e) {
    return { idempotencyKey: order.idempotencyKey, error: e.message,
             code: e.code ?? 'UNKNOWN', status: 'failed' };
  }
}
```

### 5.5 LWW 冲突解决

**冲突场景**：同一订单在前端被修改（如改数量后再次结账），生成新 idempotencyKey 还是复用？

**策略**：
- **创建即冻结**：订单结账后生成 idempotencyKey，存入 IndexedDB 后**不再修改**。前端 UI 上"已结账"订单锁定，不允许编辑。
- **挂单可改**：
  - **在线挂单**：Draft Order 在后端已创建（`orderType=hold`），无 idempotencyKey（idempotencyKey 仅用于离线创建场景）。挂单/取单操作直接调 `holdOrder`/`resumeOrder` mutation 修改后端 Order。
  - **离线挂单**：断网时挂单仅存前端内存（不入 IndexedDB orders 表，因未结账）。恢复网络后继续操作或结账时按正常在线流程提交。如果断网期间关闭班次且仍有挂单未结账，本地 ShiftSummary 中 `heldCount` 计入但不需要同步对应 Order。
- **退货单**：退货单一旦结账立即生成 idempotencyKey，不允许修改。
- **同步失败重提**：必须由收银员在前端确认（弹窗"订单 X 同步失败，是否重试？"），不自动重提避免错误数据覆盖。

**LWW 仅适用场景**：同一 idempotencyKey 的多次同步尝试（如网络抖动导致重发），以 `clientUpdatedAt` 最新为准。但已 success 的记录**永不覆盖**（防止重复扣库/重复支付）。

### 5.6 库存冲突处理

断网期间多终端各自扣库存，联网后可能超卖。

**策略**：**乐观扣减 + 失败回滚 + 人工兜底**

```typescript
async createPosOrder(ctx, order: OfflineOrderRecord) {
  const newOrder = await this.orderService.createDraft(ctx);
  
  for (const line of order.lines) {
    try {
      await this.orderService.addItemToOrder(
        ctx, newOrder.id, line.productVariantId, line.quantity, 
        { customFields: { 
            discount: line.discount, 
            originalPrice: line.originalPrice,
            memberPriceApplied: line.memberPriceApplied,
            isGift: line.isGift,
          }
        }
      );
    } catch (e) {
      if (e.message?.includes('Insufficient stock')) {
        await this.orderService.transitionToState(
          ctx, newOrder.id, 'Cancelled');
        throw new VcashError(
          `商品 ${line.name} 库存不足，订单已取消，需人工处理`,
          'OUT_OF_STOCK'
        );
      }
      throw e;
    }
  }
  // 转入支付...
}
```

**库存不足时的前端处理**：

- **作废**：前端删除 IndexedDB 该订单记录（标记 syncStatus=cancelled），后端 Order 已 Cancelled
- **部分结算**：前端修改该行数量为 4，重新生成新 idempotencyKey 同步（旧 key 标记 cancelled 不再同步）
- **重试**：仅当门店补货后（联网查询库存 > 0）可重试

### 5.7 商品/会员缓存增量同步

```typescript
async function syncProducts() {
  const lastCursor = await db.syncMeta.get('products_last_cursor');
  const result = await graphqlClient.query({
    query: SYNC_PRODUCTS,
    variables: { 
      since: lastCursor?.value ?? '1970-01-01T00:00:00Z',
      limit: 500,
    }
  });
  
  await db.transaction('rw', db.products, db.syncMeta, async () => {
    await db.products.bulkPut(result.data.syncProducts.items.map(p => ({
      ...p,
      updatedAt: result.data.syncProducts.serverUpdatedAt,
    })));
    await db.syncMeta.put({ 
      key: 'products_last_cursor', 
      value: result.data.syncProducts.cursor 
    });
  });
}

// 调度: 联网时每 5 分钟一次, 断网停止
```

### 5.8 班次关闭与离线协调

```
[收银员点"交班"]
       │
       ▼
[本地生成 ShiftSummary] ── 依赖 IndexedDB 内 orders/payments
       │
       ▼
[本地标记 session.state=closed]
       │
       ▼
[触发全量同步: session + 所有 pending orders/payments]
       │
       ├── 全部成功 → session.syncStatus=success
       │
       └── 部分/全部失败 → session.syncStatus=failed
                         → UI 显示"班次已关闭但同步未完成"
                         → 联网后自动重试 pending 记录
```

**店长确认的离线处理**：Channel 配置 `requireShiftApproval=true` 时：
- 在线：closeSession mutation 必须带 `approverCode`，服务端校验店长身份
- 离线：closeSession 本地标记 `pendingApproval`，前端提示"需店长确认"。店长可在自己的 POS 终端（或管理后台）联网后批量审批 pendingApproval 班次

### 5.9 同步触发时机

| 触发器 | 条件 | 操作 |
|--------|------|------|
| 网络恢复 | `navigator.onLine` 从 false→true | 立即触发全量 pending 同步 |
| 订单结账 | 在线时 | 立即同步该单（不等队列） |
| 队列调度 | 在线时 | 每 30 秒扫描 pending 记录批量同步 |
| 班次关闭 | 任何时候 | 强制全量同步该班次所有记录 |
| 手动重试 | 收银员点"重试" | 同步指定 failed 记录 |

---

## 6. 外设集成

### 6.1 外设能力矩阵

| 外设 | 浏览器 API | 协议 | 同步/异步 | 失败降级 |
|------|-----------|------|----------|---------|
| 扫码枪 | KeyboardEvent（HID 仿真） | 键盘输入 | 同步 | 手动输入条码 |
| 电子秤 | Web Serial API | RS232 串口指令 | 异步轮询 | 手动输入重量 |
| 钱箱 | Web USB API | ESC-POS 指令 | 异步 | 手动打开 |
| ESC-POS 打印 | Web USB / Web Serial | ESC-POS 二进制指令 | 异步 | 浏览器原生打印 |

### 6.2 设备管理抽象

```typescript
interface DeviceManager {
  scanner: ScannerAdapter;
  scale: WeightScaleAdapter | null;
  cashDrawer: CashDrawerAdapter | null;
  printer: PrinterAdapter | null;
  status: ComputedRef<DeviceStatus>;
  init(): Promise<DeviceInitResult>;
}

interface DeviceStatus {
  scanner: 'connected' | 'disconnected';
  scale: 'connected' | 'disconnected' | 'unsupported';
  cashDrawer: 'connected' | 'disconnected' | 'unsupported';
  printer: 'connected' | 'disconnected' | 'unsupported';
}
```

**降级原则**：每个外设独立连接状态，单个外设失败不影响其他。前端 UI 显示设备状态指示灯。

### 6.3 扫码枪（useScanner）

HID 仿真扫码枪：键盘事件序列（快速输入 + 回车结束）。

```typescript
export function useScanner(options: {
  onScan: (barcode: string) => void;
  minLength?: number;
  maxInterval?: number;  // 默认 50ms 区分人工输入
}) {
  let buffer = '';
  let lastTime = 0;
  
  function handleKeydown(e: KeyboardEvent) {
    const now = Date.now();
    if (now - lastTime > (options.maxInterval ?? 50) || 
        e.key.length > 1 && e.key !== 'Enter') {
      buffer = '';
    }
    if (e.key === 'Enter' && buffer.length >= (options.minLength ?? 4)) {
      options.onScan(buffer);
      buffer = '';
      e.preventDefault();
      return;
    }
    if (e.key.length === 1) {
      buffer += e.key;
      lastTime = now;
    }
  }
  
  onMounted(() => window.addEventListener('keydown', handleKeydown));
  onUnmounted(() => window.removeEventListener('keydown', handleKeydown));
}
```

**关键设计**：
- 全局监听（不绑定特定输入框），扫码即触发加商品
- `maxInterval=50ms` 区分人工键盘输入与扫码枪
- 无需用户授权（HID 设备原生支持）
- **降级**：UI 提供手动输入条码弹窗（F2 快捷键触发）

### 6.4 电子秤（useWeightScale）

Web Serial API，RS232 协议（连续发送重量数据或请求-响应）。

```typescript
export function useWeightScale() {
  const weight = ref<number | null>(null);
  const status = ref<'disconnected' | 'connected' | 'unsupported'>('disconnected');
  let port: SerialPort | null = null;
  
  async function connect() {
    if (!('serial' in navigator)) {
      status.value = 'unsupported';
      return false;
    }
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
    status.value = 'connected';
    startReading();
    return true;
  }
  
  // 持续读取串口数据，解析重量
  // 协议示例: "ST,GS,+  1.234kg\r\n"（连续发送模式）
  
  async function readStableWeight(timeoutMs = 5000): Promise<number> {
    // 连续 3 次读取相同（±0.005kg）视为稳定
  }
  
  return { weight, status, connect, disconnect, readStableWeight };
}
```

**计重商品流程**：
1. 收银员选计重商品（或扫码触发 isWeighted=true）
2. 弹出 WeightInputDialog，自动读取秤的稳定重量
3. 重量 × 单价 = 行金额，自动加入购物车

**降级**：Web Serial 不支持时（如 HTTP 非 HTTPS、旧浏览器），UI 显示"电子秤未连接，请手动输入重量"。

### 6.5 钱箱（useCashDrawer）

Web USB API + ESC-POS 开钱箱指令。

```typescript
export function useCashDrawer() {
  const status = ref<'disconnected' | 'connected' | 'unsupported'>('disconnected');
  let device: USBDevice | null = null;
  
  async function connect() {
    if (!('usb' in navigator)) {
      status.value = 'unsupported';
      return false;
    }
    device = await navigator.usb.requestDevice({
      filters: [
        { vendorId: 0x04b8 },  // Epson
        { vendorId: 0x0519 },  // Star
        { vendorId: 0x0fe4 },  // Generic
      ]
    });
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    await device.claimInterface(0);
    status.value = 'connected';
    return true;
  }
  
  async function open() {
    if (!device) throw new Error('钱箱未连接');
    // ESC-POS 开钱箱指令: ESC p m t1 t2 (m=0 Connector 1, m=1 Connector 2)
    const command = new Uint8Array([0x1b, 0x70, 0x00, 0x3c, 0x00]);
    await device.transferOut(1, command);
  }
  
  return { status, connect, open };
}
```

**触发时机**：现金支付结账成功后自动开钱箱。

**降级**：UI 显示"请手动打开钱箱"提示。

### 6.6 ESC-POS 打印（useEscposPrinter）

Web USB 或 Web Serial 连接热敏打印机，发送 ESC-POS 二进制指令。

```typescript
export function useEscposPrinter() {
  const status = ref<'disconnected' | 'connected' | 'unsupported'>('disconnected');
  
  async function connectUSB() {
    // 请求 USB 设备（Epson/Star/SNBC/Custom 等厂商 ID）
    // 选择 configuration, claim interface, 找输出端点
  }
  
  async function printReceipt(receipt: ReceiptData) {
    const commands = buildReceiptCommands(receipt);
    // 通过 USB endpoint 或 Serial port 写入二进制指令
  }
  
  function buildReceiptCommands(receipt: ReceiptData): Uint8Array {
    // ESC @ 初始化
    // 标题（居中，双倍宽高）
    // 商品行（左对齐名称 + 右对齐金额）
    // 合计（双倍高度）
    // 支付明细 + 找零
    // 切纸指令 (ESC d V 0)
  }
  
  return { status, connectUSB, printReceipt };
}
```

### 6.7 打印降级链

```
ESC-POS 指令打印
     │ 失败
     ▼
浏览器原生打印（HTML 模板，复用 zhao_market_pos ReceiptTemplate 思路）
     │ 失败
     ▼
保存为 PDF 下载
```

**ESC-POS 中文编码**：默认编码不支持中文，`buildReceiptCommands` 开头需发 `FS &`（0x1c 0x26）切换中文模式，文字用 GBK 编码（`TextEncoder` 不支持 GBK，需引入 `iconv-lite` 或用 `TextDecoder` 的 GBK polyfill）。部分打印机支持 UTF-8 模式（`GS ( k` 命令），优先尝试 UTF-8，失败回退 GBK。

### 6.8 设备初始化时机

```typescript
// web/src/App.vue
onMounted(async () => {
  const deviceManager = usePosDevices();
  deviceManager.scanner.start();  // 扫码枪无需授权
  
  // USB/Serial 设备需要用户手势触发授权
  if (sessionStorage.getItem('devices_setup_done') !== 'true') {
    showSetupDialog();
  }
});
```

SetupView 引导用户依次连接电子秤、钱箱、打印机，授权后存 sessionStorage。

### 6.9 外设配置实体

PosTerminal deviceConfig 字段（jsonb）记录打印机 vendorId/productId、电子秤波特率、钱箱是否通过打印机驱动、纸宽 58/80 等。但 WebUSB/WebSerial 授权是浏览器层面的（基于 origin+device），后端配置仅作为设备型号参考，不能跨浏览器复用授权。

---

## 7. 前端结构

### 7.1 技术栈选型

| 维度 | 选型 | 理由 |
|------|------|------|
| 框架 | Vue 3 + `<script setup>` | 沿用 zhao_market_pos 技术栈 |
| 状态管理 | Pinia | 同上 |
| 路由 | Vue Router 4 | SPA 多视图切换 |
| GraphQL 客户端 | Apollo Client 3 | 成熟缓存、订阅、离线能力 |
| UI 组件库 | Element Plus | 中文生态、表格/弹窗成熟 |
| 离线存储 | Dexie.js（IndexedDB） | 事务、索引、响应式 |
| 构建工具 | Vite 5 | 快速冷启动、HMR |
| 类型生成 | GraphQL Codegen | 从 schema 自动生成 TS 类型 |
| PWA | Vite PWA Plugin | Service Worker 缓存静态资源 |

### 7.2 领域类型（无 Odoo 残留）

```typescript
export interface PosProduct {
  variantId: number;
  productId: number;
  name: string;
  barcode: string | null;
  sku: string;
  price: number;                  // Channel 定价（分）
  memberPrice: number | null;     // 商品级会员价（分）
  category: PosCategory | null;
  uom: 'piece' | 'kg';
  isWeighted: boolean;
  stockLevel: number;
}

export interface PosMember {
  customerId: number;
  name: string;
  mobile: string;
  level: MemberLevel;
  discountRate: number;           // 等级折扣 88=88折
}

export interface CartLine {
  variantId: number;
  name: string;
  qty: number;
  priceUnit: number;              // 折后单价（分）
  originalPrice: number;
  discount: number;               // 100=原价, 88=88折
  isGift: boolean;
  memberPriceApplied: boolean;
  note: string;
  isWeighted: boolean;
}

export interface PaymentItem {
  paymentId?: number;
  pendingPaymentId?: string;
  method: 'cash' | 'wechat' | 'alipay' | 'mixed';
  amount: number;
  aggregatePayCode?: string;
  aggregatePayStatus?: 'pending' | 'confirmed' | 'settled' | 'failed';
}

export interface SessionInfo {
  sessionId: number | null;
  sessionCode: string | null;
  terminalCode: string;
  operatorName: string;
  state: 'open' | 'closed' | null;
  openedAt: string | null;
  openingFloat: number;
}

export interface ShiftSummary {
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

export interface ReceiptData {
  header: string;
  phone: string;
  address: string;
  footer: string;
  orderCode: string;
  createdAt: string;
  cashier: string;
  lines: ReceiptLine[];
  total: number;
  payments: ReceiptPayment[];
  change: number | null;
}
```

### 7.3 Stores 设计

**cart.ts**：购物车行 + 会员 + 挂单列表 + 当前 Order ID（在线）/idempotencyKey（离线）。`addProduct` 内部计算折扣（商品级会员价优先于等级折扣），`holdOrder`/`resumeOrder` 处理挂单取单。

**session.ts**：班次状态。`open`/`close` 调 GraphQL；离线时写 IndexedDB 并触发全量同步。

**payment.ts**：当前订单支付项。聚合码 pending 状态轮询。

**pending.ts**：聚合码待确认支付列表。

**offline.ts**：网络状态 + pending/syncing/failed 计数。监听 `online`/`offline` 事件，每 30 秒扫描 pending 队列。

### 7.4 Composables 职责

| Composable | 职责 |
|-----------|------|
| useScanner | HID 扫码枪全局监听，maxInterval=50ms 区分人工输入 |
| useWeightScale | WebSerial 电子秤，连续读取 + 稳定判定 + readStableWeight |
| useCashDrawer | WebUSB 钱箱，ESC-POS 开钱箱指令 |
| useEscposPrinter | WebUSB/WebSerial 热敏打印，ESC-POS 指令构建 + 切纸 |
| useOfflineSync | 离线队列调度，syncOrder/syncPending/triggerFullSync/checkoutOffline |
| usePosSession | 班次生命周期，ensureOpenSession 路由守卫 |
| useMemberCache | 会员快照查询（IndexedDB 优先，联网回源） |
| useIncrementalSync | 商品/会员增量同步，每 5 分钟一次 |
| useShortcut | F1-F12 快捷键矩阵 |
| useLabelPrinter | 标签打印（如生鲜称重标签） |

### 7.5 视图设计

**CashierView（主收银页）**：
- 左侧分类栏 + 商品网格
- 右侧购物车 + 会员显示 + 合计
- 顶部终端/班次信息 + 设备状态指示灯
- F1-F12 快捷键：F1 条码聚焦、F2 手动条码、F3 计重模式、F4 挂单、F5 取单、F6 会员、F9 结账、F12 交班

**CheckoutView（结账页）**：
- 订单合计 + 会员 + 商品明细
- 支付方式选择（现金/微信/支付宝/聚合码）
- 聚合码待确认面板（支付码 + 状态 + 确认按钮）
- 找零显示 + 完成支付并打印

**ShiftView（交班页）**：
- 当前班次信息
- 班次汇总（订单统计 + 支付方式汇总 + 异常提醒）
- 实交现金输入 + 店长确认（如需）+ 确认交班

**RefundView（退货页）**：
- 原单查询（单号）
- 原单明细 + 退货选择（勾选 + 退货数量）
- 退款合计 + 退款方式 + 退货原因

**SetupView（设备初始化页）**：
- 引导连接电子秤、钱箱、打印机
- 设备状态实时显示

### 7.6 登录与 Channel/StockLocation 切换

POS 前端启动流程：

```
[启动]
  │
  ▼
[登录页] Administrator 账号密码
  │  调 Admin API login mutation → 获取 vendure-token
  │
  ▼
[选门店页] 列出当前 Administrator 可访问的 Channel + StockLocation
  │  前端存储选中的 channelId + stockLocationId + terminalCode
  │  Apollo 客户端注入 channelToken header
  │
  ▼
[SetupView] 设备初始化（首次）
  │
  ▼
[CashierView] 开班 → 收银
```

```typescript
// web/src/api/graphql-client.ts
const apolloClient = new ApolloClient({
  link: createHttpLink({
    uri: '/admin-api',
    headers: () => {
      const token = useAuthStore().token;
      return token ? { Authorization: `Bearer ${token}` } : {};
    },
  }),
  cache: new InMemoryCache(),
});

// 选门店后，Channel 切换通过 Vendure 的 channelToken header
function setChannel(channelToken: string) {
  apolloClient.link = createHttpLink({
    uri: '/admin-api',
    headers: {
      Authorization: `Bearer ${useAuthStore().token}`,
      'vendure-token': channelToken,  // Channel 隔离
    },
  });
}
```

**登录态持久化**：token + channelId + terminalCode 存 localStorage，刷新页面自动恢复。

### 7.7 路由与权限

```typescript
const routes = [
  { path: '/', redirect: '/cashier' },
  { path: '/setup', component: SetupView, meta: { public: true } },
  { path: '/cashier', component: CashierView, meta: { requiresSession: true } },
  { path: '/checkout', component: CheckoutView, 
    meta: { requiresSession: true, requiresCart: true } },
  { path: '/refund', component: RefundView, meta: { requiresSession: true } },
  { path: '/shift', component: ShiftView, meta: { requiresSession: true } },
];

router.beforeEach(async (to) => {
  if (to.meta.requiresSession) {
    const { ensureOpenSession } = usePosSession();
    const ok = await ensureOpenSession();
    if (!ok) return '/setup';
  }
  if (to.meta.requiresCart) {
    const cart = useCartStore();
    if (cart.lines.length === 0) return '/cashier';
  }
});
```

### 7.8 关键改造点（对比 zhao_market_pos）

| 维度 | zhao_market_pos | vcash | 改造原因 |
|------|-----------------|-------|---------|
| API 层 | REST + 手写类型 | GraphQL + Codegen | Vendure 原生 GraphQL |
| 类型 | `product_tmpl_id`, `categ_id` | `variantId`, `categoryId` | 去 Odoo 命名 |
| 状态 | 单一 session store | session + offline 分离 | 离线同步独立 |
| 离线 | 无 | IndexedDB 队列 + 自动同步 | 全离线要求 |
| 外设 | 仅扫码枪 + 浏览器打印 | 扫码枪+秤+钱箱+ESC-POS | 全外设要求 |
| 路由 | 无 | Vue Router 4 | 多视图清晰分离 |

---

## 8. 测试策略

### 8.1 测试分层

| 层级 | 范围 | 工具 | 目标 |
|------|------|------|------|
| L1 单元 | 服务层/工具函数/composables | Vitest | 业务逻辑正确性 |
| L2 集成 | 插件 + Vendure Core | Vitest + @vendure/testing | 跨服务协作正确 |
| L3 E2E | 完整收银流程 | Playwright | 端到端业务可用 |
| L4 离线专项 | 断网/恢复/冲突 | Vitest + MSW | 离线状态机正确 |
| L5 外设模拟 | 扫码枪/秤/钱箱/打印 | Vitest + Mock | 外设降级链 |

### 8.2 后端测试要点

- **L1 单元**：ShiftReportService.generateSummary（订单统计/支付汇总/差额告警）
- **L2 集成**（@vendure/testing）：
  - 完整流程：创建终端 → 开班 → 加商品 → 结账 → 关班
  - 多终端并发：同门店 2 个终端同时收银互不干扰
  - 退货：退款单关联原单，库存回退
  - 库存隔离：同商品在朝阳店/海淀店库存独立
  - 聚合码支付：pending → confirmed 状态机
  - 会员价：等级折扣 + 商品级折扣优先级
  - 权限校验：无活跃 session 时 POS 操作被拒

### 8.3 离线同步专项测试

- 幂等性：同 idempotencyKey 重复提交不创建多单
- LWW：失败后修改 clientUpdatedAt 重试成功
- 库存冲突：乐观扣减失败时返回 OUT_OF_STOCK
- 批量同步：部分成功部分失败，返回分类结果

### 8.4 前端测试

- **Composables 单元**：useScanner 识别快速输入/忽略人工输入/阻止 Enter 默认行为
- **Store 单元**：cart store 加商品（新增/累加）、会员折扣优先级
- **E2E（Playwright）**：
  - 开班 → 加商品 → 现金结账 → 打印 → 关班
  - 离线结账 → 恢复网络 → 自动同步
  - 多终端并发：两台 POS 同时收银不冲突
  - 退货：查原单 → 选退货商品 → 退款
  - 聚合码支付：创建待确认 → 收银员确认
  - 外设降级：打印机未连接时降级到浏览器打印

### 8.5 测试数据策略

| 数据类型 | 来源 | 备注 |
|---------|------|------|
| 商品/分类 | `e2e/products.csv` | @vendure/testing populate |
| 会员 | `e2e/customers.csv` | 含 member-level custom fields |
| 多门店 | testConfig.initialData.stockLocations | 朝阳店 + 海淀店 |
| POS 终端 | 测试用例内创建 | 不在 initialData 中 |
| 订单/支付 | 测试用例内生成 | 各用例独立 |

**测试数据库**：SQLite 内存模式（@vendure/testing 默认），快、隔离、CI 友好。生产用 PostgreSQL。

### 8.6 CI 流水线

```yaml
name: CI
on: [push, pull_request]
jobs:
  backend-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter vcash-pos-plugin build
      - run: pnpm --filter vcash-pos-plugin test
      - run: pnpm --filter vcash-offline-plugin build
      - run: pnpm --filter vcash-offline-plugin test
  
  frontend-test:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter web codegen
      - run: pnpm --filter web lint
      - run: pnpm --filter web test:unit
  
  e2e-test:
    needs: [backend-test, frontend-test]
    steps:
      - run: pnpm --filter server build
      - run: pnpm --filter web build
      - run: pnpm --filter server start:e2e &
      - run: pnpm --filter web preview &
      - run: pnpm --filter web test:e2e
```

---

## 9. 部署

### 9.1 部署架构

```
┌─────────────────────────────────────────────────────────┐
│  ┌────────────┐       ┌─────────────────────────────┐  │
│  │  Nginx     │──────►│  Vendure Server (Node.js)    │  │
│  │  :80/:443  │       │  - Admin API                 │  │
│  │ 静态:      │       │  - Shop API (POS GraphQL)    │  │
│  │  /pos/*    │       │  - VcashPosPlugin            │  │
│  │  → web/dist│       │  - VcashOfflinePlugin        │  │
│  └────────────┘       │  - MemberLevelPlugin         │  │
│                       │  - CjkPlugin                 │  │
│                       └────────────┬────────────────┘  │
│                       ┌────────────▼────────────────┐  │
│                       │  PostgreSQL                  │  │
│                       │  - Vendure schema            │  │
│                       │  - vcash-pos 实体表           │  │
│                       │  - vcash-offline 队列表       │  │
│                       └─────────────────────────────┘  │
│                       ┌─────────────────────────────┐  │
│                       │  Redis (可选)                │  │
│                       │  - Job Queue                 │  │
│                       │  - Session Cache             │  │
│                       └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 9.2 部署清单

- Vendure Server: PM2 守护，2+ 实例（前端无状态，可水平扩展）
- PostgreSQL: 单实例（MVP），生产可主从
- Nginx: 反代 + 静态托管 `web/dist`
- HTTPS: 必须（WebUSB/WebSerial 要求 Secure Context）
- 浏览器: Chrome/Edge 90+（WebUSB/WebSerial 兼容性）

**HTTPS 证书方案**：
- 公网部署：Let's Encrypt 免费证书（certbot 自动续期）
- 局域网部署（POS 终端不联公网）：用 `mkcert` 生成本地信任的根证书 + 域名证书，根证书需导入每台 POS 终端的系统信任区
- 自签证书：不推荐（浏览器 WebUSB 授权会持续警告）

### 9.3 生产目录结构

```
/opt/vcash/
├── current/                # 当前版本（symlink）
│   ├── server/
│   │   ├── dist/
│   │   ├── node_modules/
│   │   ├── package.json
│   │   └── vendure-config.js
│   ├── web/
│   │   └── dist/
│   └── package.json
├── releases/
│   └── 20260801-abc123/
├── shared/
│   ├── uploads/
│   └── logs/
└── .env
```

### 9.4 环境变量

```bash
DB_HOST=localhost
DB_PORT=5432
DB_NAME=vcash
DB_USER=vcash
DB_PASSWORD=***
REDIS_HOST=localhost
REDIS_PORT=6379
VENDURE_ADMIN_API_PATH=admin-api
VENDURE_SHOP_API_PATH=shop-api
PORT=3000
JWT_SECRET=***
VENDURE_TOKEN_SECRET=***
```

### 9.5 构建产物

| 包 | 命令 | 产物 |
|----|------|------|
| vcash-pos-plugin | `pnpm build` | `dist/index.js` + `dist/index.d.ts` |
| vcash-offline-plugin | `pnpm build` | `dist/index.js` + `dist/index.d.ts` |
| server | `pnpm build` | `dist/vendure-config.js` |
| web | `pnpm build` | `dist/` (Vite 静态产物) |
| web types | `pnpm codegen` | `src/api/types.ts` |

---

## 10. MVP 范围

| 能力 | MVP | 后续 |
|------|-----|------|
| 多租户 Channel | ✓ | - |
| 多仓库 StockLocation | ✓ | - |
| POS 终端 + 班次 | ✓ | - |
| 商品/会员/扫码收银 | ✓ | - |
| 现金 + 聚合码支付 | ✓ | 微信/支付宝 API |
| 退货 | ✓ | - |
| 交班（可选店长确认） | ✓ | - |
| 离线全收银 | ✓ | - |
| 外设（扫码/秤/钱箱/ESC-POS） | ✓ | - |
| 会员等级折扣 | ✓ | 积分扣减 |
| 发票 | 后续 | MVP 仅预留字段 |
| 多语言 | 后续 | MVP 仅中文 |
| 报表 | 后续 | MVP 仅班次对账单 |

### 10.1 历史数据迁移

**MVP 不含 Odoo 历史数据迁移**。理由：
1. zhao_market_pos 与 vcash 数据模型差异大（Odoo product/member → Vendure ProductVariant/Customer），直接迁移需大量字段映射
2. POS 历史订单的财务价值低（门店日结后历史订单主要用于查询），可保留 Odoo 系统只读访问
3. 商品/会员主数据建议重新录入或写一次性脚本从 Odoo 导出 CSV → Vendure populate

**后续如需迁移**：写独立迁移脚本，从 Odoo PostgreSQL 读 → 转换 → Vendure Admin API 写入，不纳入 vcash 主代码库。

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| WebUSB/WebSerial 浏览器兼容性 | 外设不可用 | 降级链兜底，要求 Chrome 90+ |
| 离线库存超卖 | 财务损失 | 乐观扣减 + 人工兜底 |
| IndexedDB 存储限制 | 离线订单丢失 | 限制本地缓存 1000 单，超限提示 |
| 聚合码支付欺诈 | 收银员误确认 | UI 二次确认 + 金额大字显示 |
| Vendure 版本升级 | 插件兼容破坏 | @vendure/* 锁定版本，升级前 E2E |
| 多终端时钟不一致 | LWW 判定错误 | 以服务端接收时间为准，前端仅参考 |
| Admin API 暴露面扩大 | 收银员权限越界 | Role 最小权限 + 活跃 session 中间件 + Channel 隔离 |
| 聚合码支付超时未感知 | 顾客已付但收银员标 failed | JobQueue 扫描 + 前端轮询双保险，failed 前弹窗二次确认 |
| ESC-POS 中文乱码 | 小票无法识别 | 优先 UTF-8 模式，回退 GBK + iconv-lite |

---

## 12. 实施顺序建议

1. **Phase 1: 基础设施**（独立项目脚手架 + Vendure 配置 + 多租户多仓库验证）
2. **Phase 2: vcash-pos-plugin 核心**（实体 + custom fields + 基础 GraphQL + 在线收银流程）
3. **Phase 3: 前端在线收银**（CashierView + CheckoutView + GraphQL 集成）
4. **Phase 4: 离线能力**（vcash-offline-plugin + IndexedDB + 同步状态机）
5. **Phase 5: 退货与交班**（RefundView + ShiftView + 对账单）
6. **Phase 6: 外设集成**（useScanner/useWeightScale/useCashDrawer/useEscposPrinter + SetupView）
7. **Phase 7: 测试完善 + 部署**（E2E 全覆盖 + CI + 生产部署）

每个 Phase 完成后跑完整 E2E，确保不回归。
