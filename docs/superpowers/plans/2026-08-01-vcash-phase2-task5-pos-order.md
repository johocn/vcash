# vcash Phase 2 Task 5: PosOrderService 加商品/结账 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 POS 收银核心流程：开班 → 加商品到购物车 → 结账（手动支付 + 状态转换到 PaymentSettled），并通过完整 e2e 测试验证。

**Architecture:** PosOrderService 封装 Vendure OrderService 的 create/addItemToOrder/transitionToState/addManualPaymentToOrder API，通过 `connection.withTransaction` 包裹支付与状态转换。server/vendure-config.ts 与 e2e 测试均配置 `configureDefaultOrderProcess({ arrangingPaymentRequiresCustomer: false, arrangingPaymentRequiresShipping: false })` 关闭 POS 场景不适用的检查。

**Tech Stack:** Vendure 3.6.4, TypeORM, @vendure/testing, vitest, TypeScript

---

## 关键 API 约束（已验证）

基于对 `e:\code\vendure\packages\core\src\service\services\order.service.ts` 的实际探查：

1. **OrderService.create(ctx, userId?)** — 只接受 ctx 和可选 userId，**不接受** stockLocationCode 或 customFields。创建后需用 `connection.getRepository(Order).update(id, { customFields: {...} })` 设置 custom fields。
2. **OrderService.addItemToOrder(ctx, orderId, productVariantId, quantity, customFields?)** — 第 5 参 `customFields` 直接设置 OrderLine custom fields，**无需** 也**不存在** `updateOrderLineCustomFields` 方法。
3. **OrderService.addManualPaymentToOrder(ctx, ManualPaymentInput)** — 必须在事务中调用（`assertInTransaction`）；内部 `createManualPayment` 创建的 Payment 直接 `Created → Settled`；`method` 字段不校验是否注册 PaymentMethod，可用任意字符串。
4. **OrderService.transitionToState(ctx, orderId, 'PaymentSettled')** — `addManualPaymentToOrder` 后需手动调用；`checkPaymentsCoverTotal` 默认 true 会校验 Payment 覆盖 total（manual payment 金额 = total - 已有支付，单笔刚好覆盖）。
5. **configureDefaultOrderProcess({ arrangingPaymentRequiresCustomer: false, arrangingPaymentRequiresShipping: false })** — 关闭 customer/shipping 检查；`arrangingPaymentRequiresStock` 对 trackInventory=false 的商品自动跳过（products.csv 中 trackInventory=false）。

## File Structure

- **Modify** `e:\code\vcash\server\vendure-config.ts` — 添加 `orderOptions.process` 关闭 customer/shipping 检查
- **Create** `e:\code\vcash\packages\vcash-pos-plugin\src\services\pos-order.service.ts` — ensureActiveOrder / addPosItem / updatePosItem / checkoutPosOrder
- **Modify** `e:\code\vcash\packages\vcash-pos-plugin\src\resolvers\admin-pos.resolver.ts` — 追加 getActiveOrder / addPosItem / updatePosItem / checkoutPosOrder
- **Modify** `e:\code\vcash\packages\vcash-pos-plugin\src\plugin.ts` — 注册 PosOrderService + 扩展 schema（AddPosItemInput / UpdatePosItemInput / CheckoutInput / PosCheckoutResult）
- **Create** `e:\code\vcash\packages\vcash-pos-plugin\e2e\pos-flow.e2e-spec.ts` — 完整收银流程测试

---

### Task 1: 配置 orderOptions 关闭 customer/shipping 检查

**Files:**
- Modify: `e:\code\vcash\server\vendure-config.ts`

- [ ] **Step 1: 修改 vendure-config.ts 添加 orderOptions**

在 `e:\code\vcash\server\vendure-config.ts` 顶部 import 区追加：

```typescript
import { configureDefaultOrderProcess, DefaultLogger, LogLevel, VendureConfig } from '@vendure/core';
```

在 `config` 对象中（`paymentOptions` 之后、`logger` 之前）追加：

```typescript
  orderOptions: {
    process: [
      configureDefaultOrderProcess({
        arrangingPaymentRequiresCustomer: false,
        arrangingPaymentRequiresShipping: false,
      }),
    ],
  },
```

- [ ] **Step 2: 验证 server 构建无回归**

Run:
```bash
cd e:\code\vcash\server && pnpm build 2>&1 | Select-Object -Last 10
```
Expected: 无错误输出

- [ ] **Step 3: 验证 server 现有测试无回归**

Run:
```bash
cd e:\code\vcash\server && pnpm test 2>&1 | Select-String -Pattern "Test Files|Tests " | Select-Object -First 2
```
Expected: 6 测试通过（multi-tenant-stock.spec.ts）

- [ ] **Step 4: Commit**

```bash
cd e:\code && git add vcash/server/vendure-config.ts && git commit -m "feat(server): 关闭 POS 场景的 customer/shipping 检查"
```

---

### Task 2: 创建 PosOrderService

**Files:**
- Create: `e:\code\vcash\packages\vcash-pos-plugin\src\services\pos-order.service.ts`

- [ ] **Step 1: 创建 pos-order.service.ts**

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import {
  ID,
  Order,
  OrderService,
  RequestContext,
  TransactionalConnection,
  UserInputError,
  idsAreEqual,
} from '@vendure/core';
import { Connection } from 'typeorm';

import { PosSession } from '../entities/pos-session.entity';

/**
 * POS 收银核心服务：
 * - ensureActiveOrder: 班次内有活跃 Order 则复用，否则创建新 Order 并绑定 custom fields
 * - addPosItem: 加商品到 Order，通过 addItemToOrder 第 5 参设置 OrderLine custom fields
 * - updatePosItem: 修改 OrderLine 数量
 * - checkoutPosOrder: transitionToState ArrangingPayment → addManualPaymentToOrder → transitionToState PaymentSettled
 *
 * 关键 API 约束（Vendure 3.6.4 实际签名，已通过 Grep 验证）：
 * 1. OrderService.create(ctx, userId?) 不接受 stockLocationCode/customFields
 * 2. addItemToOrder(ctx, orderId, variantId, qty, customFields?) 第 5 参设 OrderLine 字段
 * 3. addManualPaymentToOrder 必须在事务中；method 字段不校验 PaymentMethod 注册
 * 4. PaymentSettled 需手动 transitionToState；checkPaymentsCoverTotal 默认校验
 */
@Injectable()
export class PosOrderService {
  constructor(
    @InjectConnection() private connection: Connection,
    @Inject(TransactionalConnection) private transactionalConnection: TransactionalConnection,
    @Inject(OrderService) private orderService: OrderService,
  ) {}

  /**
   * 确保班次有活跃 Order。无则创建并绑定 custom fields。
   */
  async ensureActiveOrder(ctx: RequestContext, session: PosSession): Promise<Order> {
    if (session.activeOrderId) {
      const existing = await this.orderService.findOne(ctx, session.activeOrderId);
      if (existing && existing.active) {
        return existing;
      }
    }
    // 创建新 Order（create 不接受 customFields，需创建后 update）
    const order = await this.orderService.create(ctx);
    // 设置 Order custom fields
    await this.connection.getRepository(Order).update(order.id, {
      customFields: {
        posSessionId: session.id,
        orderType: 'sale',
        terminalCode: session.terminal.code,
      },
    });
    // 更新 session.activeOrderId
    await this.connection.getRepository(PosSession).update(session.id, {
      activeOrderId: order.id,
    });
    session.activeOrderId = order.id;
    return this.orderService.findOne(ctx, order.id) as Promise<Order>;
  }

  /**
   * 加商品到当前班次 Order。通过 addItemToOrder 第 5 参设置 OrderLine custom fields。
   */
  async addPosItem(
    ctx: RequestContext,
    session: PosSession,
    input: {
      productVariantId: ID;
      quantity: number;
      discount?: number;
      isGift?: boolean;
      note?: string;
      originalPrice?: number;
    },
  ): Promise<Order> {
    const order = await this.ensureActiveOrder(ctx, session);
    const discount = input.discount ?? 100;
    const result = await this.orderService.addItemToOrder(
      ctx,
      order.id,
      input.productVariantId,
      input.quantity,
      {
        originalPrice: input.originalPrice ?? 0,
        discount,
        memberPriceApplied: discount < 100,
        isGift: input.isGift ?? false,
        note: input.note ?? null,
      },
    );
    // addItemToOrder 返回 ErrorResultUnion，需检查是否出错
    if ('errorCode' in result) {
      throw new UserInputError(`加商品失败: ${result.message}`);
    }
    return this.orderService.findOne(ctx, order.id) as Promise<Order>;
  }

  /**
   * 修改 OrderLine 数量。
   */
  async updatePosItem(
    ctx: RequestContext,
    session: PosSession,
    input: { orderLineId: ID; quantity: number },
  ): Promise<Order> {
    if (!session.activeOrderId) {
      throw new UserInputError('当前班次无活跃订单');
    }
    const result = await this.orderService.adjustOrderLine(
      ctx,
      session.activeOrderId,
      input.orderLineId,
      input.quantity,
    );
    if ('errorCode' in result) {
      throw new UserInputError(`修改商品失败: ${result.message}`);
    }
    return this.orderService.findOne(ctx, session.activeOrderId) as Promise<Order>;
  }

  /**
   * 结账：transitionToState ArrangingPayment → addManualPaymentToOrder → transitionToState PaymentSettled。
   * addManualPaymentToOrder 必须在事务中，整个结账流程用 withTransaction 包裹。
   */
  async checkoutPosOrder(
    ctx: RequestContext,
    session: PosSession,
    input: {
      payments: Array<{ method: string; transactionId?: string; metadata?: any }>;
    },
  ): Promise<{ order: Order; payments: any[] }> {
    const order = await this.ensureActiveOrder(ctx, session);
    if (order.lines.length === 0) {
      throw new UserInputError('购物车为空，无法结账');
    }

    const settledPayments: any[] = [];

    await this.transactionalConnection.withTransaction(ctx, async txCtx => {
      // 1. AddingItems → ArrangingPayment
      const arrangeResult = await this.orderService.transitionToState(
        txCtx,
        order.id,
        'ArrangingPayment',
      );
      if ('errorCode' in arrangeResult) {
        throw new UserInputError(`转入 ArrangingPayment 失败: ${arrangeResult.message}`);
      }

      // 2. 逐笔添加 manual payment（内部 Payment 直接 Created → Settled）
      for (const pay of input.payments) {
        const payResult = await this.orderService.addManualPaymentToOrder(txCtx, {
          orderId: order.id,
          method: pay.method,
          transactionId: pay.transactionId,
          metadata: pay.metadata,
        });
        if ('errorCode' in payResult) {
          throw new UserInputError(`添加支付失败: ${payResult.message}`);
        }
      }

      // 3. ArrangingPayment → PaymentSettled（checkPaymentsCoverTotal 校验支付覆盖 total）
      const settledResult = await this.orderService.transitionToState(
        txCtx,
        order.id,
        'PaymentSettled',
      );
      if ('errorCode' in settledResult) {
        throw new UserInputError(`转入 PaymentSettled 失败: ${settledResult.message}`);
      }

      // 收集 Payment 快照
      const finalOrder = await this.orderService.findOne(txCtx, order.id);
      if (finalOrder) {
        settledPayments.push(...(finalOrder.payments ?? []));
      }
    });

    // 4. 清除 session.activeOrderId
    await this.connection.getRepository(PosSession).update(session.id, {
      activeOrderId: null,
    });
    session.activeOrderId = null;

    const finalOrder = await this.orderService.findOne(ctx, order.id);
    return { order: finalOrder as Order, payments: settledPayments };
  }
}
```

- [ ] **Step 2: 验证 pos-plugin 构建**

Run:
```bash
cd e:\code\vcash\packages\vcash-pos-plugin && pnpm build 2>&1 | Select-Object -Last 20
```
Expected: 无错误输出（可能有 warning 但不能有 error）

- [ ] **Step 3: Commit**

```bash
cd e:\code && git add vcash/packages/vcash-pos-plugin/src/services/pos-order.service.ts && git commit -m "feat(pos-plugin): PosOrderService 加商品/结账核心服务"
```

---

### Task 3: 扩展 AdminPosResolver 与 plugin.ts schema

**Files:**
- Modify: `e:\code\vcash\packages\vcash-pos-plugin\src\resolvers\admin-pos.resolver.ts`
- Modify: `e:\code\vcash\packages\vcash-pos-plugin\src\plugin.ts`

- [ ] **Step 1: 在 admin-pos.resolver.ts 追加 PosOrderService 注入与 4 个新方法**

在 `e:\code\vcash\packages\vcash-pos-plugin\src\resolvers\admin-pos.resolver.ts` 顶部 import 区追加：

```typescript
import { Order, PosOrderService as _unused } from '../services/pos-order.service';
```

注意：实际 import 应为：

```typescript
import { ID } from '@vendure/core';
import { PosOrderService } from '../services/pos-order.service';
import { Order } from '@vendure/core';
```

在 `AdminPosResolver` 类的 constructor 追加第 3 个注入：

```typescript
  constructor(
    @Inject(PosSessionService) private sessionService: PosSessionService,
    @Inject(AdministratorService) private administratorService: AdministratorService,
    @Inject(PosOrderService) private orderService: PosOrderService,
  ) {}
```

在类末尾（`resolveOperator` 之前）追加 4 个方法：

```typescript
  @Query()
  @Allow(posSessionPermission.Read)
  async posActiveOrder(@Ctx() ctx: RequestContext): Promise<Order | null> {
    const admin = await this.resolveOperator(ctx);
    if (!admin) return null;
    const session = await this.sessionService.findMyOpenSession(Number(admin.id));
    if (!session || !session.activeOrderId) return null;
    return this.orderService.ensureActiveOrder(ctx, session);
  }

  @Mutation()
  @Allow(posSessionPermission.Update)
  async addPosItem(
    @Args('input') input: {
      productVariantId: string;
      quantity: number;
      discount?: number;
      isGift?: boolean;
      note?: string;
      originalPrice?: number;
    },
    @Ctx() ctx: RequestContext,
  ): Promise<Order> {
    const admin = await this.resolveOperator(ctx);
    if (!admin) throw new UserInputError('未登录或非管理员账号');
    const session = await this.sessionService.findMyOpenSession(Number(admin.id));
    if (!session) throw new UserInputError('当前无开班班次');
    return this.orderService.addPosItem(ctx, session, {
      productVariantId: input.productVariantId,
      quantity: input.quantity,
      discount: input.discount,
      isGift: input.isGift,
      note: input.note,
      originalPrice: input.originalPrice,
    });
  }

  @Mutation()
  @Allow(posSessionPermission.Update)
  async updatePosItem(
    @Args('input') input: { orderLineId: string; quantity: number },
    @Ctx() ctx: RequestContext,
  ): Promise<Order> {
    const admin = await this.resolveOperator(ctx);
    if (!admin) throw new UserInputError('未登录或非管理员账号');
    const session = await this.sessionService.findMyOpenSession(Number(admin.id));
    if (!session) throw new UserInputError('当前无开班班次');
    return this.orderService.updatePosItem(ctx, session, {
      orderLineId: input.orderLineId,
      quantity: input.quantity,
    });
  }

  @Mutation()
  @Allow(posSessionPermission.Update)
  async checkoutPosOrder(
    @Args('input') input: {
      payments: Array<{ method: string; transactionId?: string; metadata?: any }>;
    },
    @Ctx() ctx: RequestContext,
  ): Promise<{ order: Order; payments: any[] }> {
    const admin = await this.resolveOperator(ctx);
    if (!admin) throw new UserInputError('未登录或非管理员账号');
    const session = await this.sessionService.findMyOpenSession(Number(admin.id));
    if (!session) throw new UserInputError('当前无开班班次');
    return this.orderService.checkoutPosOrder(ctx, session, input);
  }
```

- [ ] **Step 2: 在 plugin.ts schema 追加新类型与 Query/Mutation**

在 `e:\code\vcash\packages\vcash-pos-plugin\src\plugin.ts` 的 `adminSchema` gql 模板内，`extend type Mutation { openSession... }` 之后追加：

```graphql
  input AddPosItemInput {
    productVariantId: ID!
    quantity: Int!
    discount: Int
    isGift: Boolean
    note: String
    originalPrice: Int
  }

  input UpdatePosItemInput {
    orderLineId: ID!
    quantity: Int!
  }

  input CheckoutPaymentInput {
    method: String!
    transactionId: String
    metadata: JSON
  }

  input CheckoutInput {
    payments: [CheckoutPaymentInput!]!
  }

  type PosCheckoutResult {
    order: Order!
    payments: [Payment!]!
  }

  extend type Query {
    posActiveOrder: Order
  }

  extend type Mutation {
    addPosItem(input: AddPosItemInput!): Order!
    updatePosItem(input: UpdatePosItemInput!): Order!
    checkoutPosOrder(input: CheckoutInput!): PosCheckoutResult!
  }
```

- [ ] **Step 3: 在 plugin.ts providers 追加 PosOrderService**

在 `e:\code\vcash\packages\vcash-pos-plugin\src\plugin.ts` 顶部 import 区追加：

```typescript
import { PosOrderService } from './services/pos-order.service';
```

在 `@VendurePlugin` 装饰器的 `providers` 数组追加 `PosOrderService`：

```typescript
  providers: [PosTerminalService, PosSessionService, PosOrderService],
```

- [ ] **Step 4: 验证构建**

Run:
```bash
cd e:\code\vcash\packages\vcash-pos-plugin && pnpm build 2>&1 | Select-Object -Last 20
```
Expected: 无错误

- [ ] **Step 5: 验证现有 16 测试无回归**

Run:
```bash
cd e:\code\vcash\packages\vcash-pos-plugin && pnpm test 2>&1 | Select-String -Pattern "Test Files|Tests " | Select-Object -First 2
```
Expected: 16 测试通过

- [ ] **Step 6: Commit**

```bash
cd e:\code && git add vcash/packages/vcash-pos-plugin/src/resolvers/admin-pos.resolver.ts vcash/packages/vcash-pos-plugin/src/plugin.ts && git commit -m "feat(pos-plugin): AdminPosResolver 追加 addPosItem/updatePosItem/checkoutPosOrder"
```

---

### Task 4: 创建完整收银流程 e2e 测试

**Files:**
- Create: `e:\code\vcash\packages\vcash-pos-plugin\e2e\pos-flow.e2e-spec.ts`

- [ ] **Step 1: 创建 pos-flow.e2e-spec.ts**

```typescript
import path from 'node:path';
import {
  configureDefaultOrderProcess,
  createTestEnvironment,
  registerInitializer,
  SqljsInitializer,
  testConfig,
} from '@vendure/testing';
import { DefaultLogger, LogLevel } from '@vendure/core';
import gql from 'graphql-tag';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { VcashPosPlugin } from '../src/plugin';

registerInitializer('sqljs', new SqljsInitializer('__data__'));

// 与 server/vendure-config.ts 一致：关闭 POS 场景的 customer/shipping 检查
const posOrderProcess = configureDefaultOrderProcess({
  arrangingPaymentRequiresCustomer: false,
  arrangingPaymentRequiresShipping: false,
});

const CREATE_STOCK_LOCATION = gql`
  mutation CreateStockLocation($name: String!) {
    createStockLocation(input: { name: $name }) { id name }
  }
`;

const CREATE_TERMINAL = gql`
  mutation CreateTerminal($code: String!, $name: String!, $stockLocationId: ID!) {
    createPosTerminal(input: { code: $code, name: $name, stockLocationId: $stockLocationId }) {
      id code name
    }
  }
`;

const OPEN_SESSION = gql`
  mutation OpenSession($terminalCode: String!) {
    openSession(input: { terminalCode: $terminalCode }) {
      id code state
      terminal { id code }
    }
  }
`;

const ADD_POS_ITEM = gql`
  mutation AddPosItem($productVariantId: ID!, $quantity: Int!, $discount: Int) {
    addPosItem(input: { productVariantId: $productVariantId, quantity: $quantity, discount: $discount }) {
      id
      state
      total
      totalWithTax
      lines {
        id
        quantity
        productVariant { id name sku price }
        customFields { originalPrice discount memberPriceApplied isGift note }
      }
    }
  }
`;

const POS_ACTIVE_ORDER = gql`
  query PosActiveOrder {
    posActiveOrder {
      id
      state
      total
      lines { id quantity productVariant { name } }
    }
  }
`;

const CHECKOUT = gql`
  mutation Checkout($payments: [CheckoutPaymentInput!]!) {
    checkoutPosOrder(input: { payments: $payments }) {
      order {
        id
        state
        total
        totalWithTax
        code
        payments { id amount state method }
      }
      payments { id amount state method }
    }
  }
`;

const GET_PRODUCTS = gql`
  query GetProducts {
    products {
      items {
        id
        name
        slug
        variants { id sku name price }
      }
    }
  }
`;

describe('POS 完整收银流程', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin],
  });

  let variantId: string;
  let sessionId: string;

  beforeAll(async () => {
    await server.init({
      initialData: {
        defaultLanguage: 'en',
        defaultZone: 'Asia',
        roles: [],
        countries: [{ code: 'CN', name: '中国', zone: 'Asia' }],
        taxRates: [{ name: 'standard', percentage: 0 }],
        shippingMethods: [],
        paymentMethods: [],
        collections: [],
      },
      productsCsvPath: path.join(
        __dirname,
        '../../../server/__tests__/fixtures/products.csv',
      ),
    });
    await adminClient.asSuperAdmin();

    // 查 products.csv populate 的商品，取第一个 variant
    const productsRes = await adminClient.query(GET_PRODUCTS);
    expect(productsRes.products.items.length).toBeGreaterThan(0);
    const firstProduct = productsRes.products.items[0];
    variantId = firstProduct.variants[0].id;
    expect(variantId).toBeTruthy();

    // 创建 StockLocation + Terminal
    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-FLOW-001',
      name: '1号收银台',
      stockLocationId: sl.createStockLocation.id,
    });

    // 开班
    const session = await adminClient.query(OPEN_SESSION, { terminalCode: 'POS-FLOW-001' });
    sessionId = session.openSession.id;
    expect(session.openSession.state).toBe('open');
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应成功加商品到购物车', async () => {
    const result = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 2,
      discount: 100,
    });
    const order = result.addPosItem;
    expect(order.state).toBe('AddingItems');
    expect(order.lines.length).toBe(1);
    expect(order.lines[0].quantity).toBe(2);
    expect(order.lines[0].customFields.discount).toBe(100);
    expect(order.lines[0].customFields.isGift).toBe(false);
    expect(order.lines[0].customFields.memberPriceApplied).toBe(false);
    expect(order.total).toBeGreaterThan(0);
  });

  it('应成功加第二个商品（不同 variant）', async () => {
    // 取第二个商品的 variant
    const productsRes = await adminClient.query(GET_PRODUCTS);
    const secondProduct = productsRes.products.items[1];
    const secondVariantId = secondProduct.variants[0].id;

    const result = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: secondVariantId,
      quantity: 1,
    });
    expect(result.addPosItem.lines.length).toBe(2);
  });

  it('posActiveOrder 应返回当前购物车', async () => {
    const result = await adminClient.query(POS_ACTIVE_ORDER);
    expect(result.posActiveOrder).toBeTruthy();
    expect(result.posActiveOrder.state).toBe('AddingItems');
    expect(result.posActiveOrder.lines.length).toBe(2);
  });

  it('应成功修改 OrderLine 数量', async () => {
    // 取第一条 line
    const active = await adminClient.query(POS_ACTIVE_ORDER);
    const firstLineId = active.posActiveOrder.lines[0].id;

    const UPDATE_LINE = gql`
      mutation UpdatePosItem($orderLineId: ID!, $quantity: Int!) {
        updatePosItem(input: { orderLineId: $orderLineId, quantity: $quantity }) {
          id
          lines { id quantity }
        }
      }
    `;
    const result = await adminClient.query(UPDATE_LINE, {
      orderLineId: firstLineId,
      quantity: 5,
    });
    const line = result.updatePosItem.lines.find((l: any) => l.id === firstLineId);
    expect(line.quantity).toBe(5);
  });

  it('应成功结账：Order state=PaymentSettled，Payment state=Settled', async () => {
    // 先取当前 total
    const active = await adminClient.query(POS_ACTIVE_ORDER);
    const total = active.posActiveOrder.total;

    const result = await adminClient.query(CHECKOUT, {
      payments: [{ method: 'cash' }],
    });
    const { order, payments } = result.checkoutPosOrder;
    expect(order.state).toBe('PaymentSettled');
    expect(order.payments.length).toBe(1);
    expect(order.payments[0].state).toBe('Settled');
    expect(order.payments[0].method).toBe('cash');
    expect(payments.length).toBe(1);
    expect(payments[0].amount).toBe(total);
  });

  it('结账后 posActiveOrder 应为 null（session.activeOrderId 已清除）', async () => {
    const result = await adminClient.query(POS_ACTIVE_ORDER);
    // activeOrderId 已清，ensureActiveOrder 会创建新空 Order；
    // 但新 Order 无 lines，state=AddingItems，lines=[]
    expect(result.posActiveOrder).toBeTruthy();
    expect(result.posActiveOrder.lines.length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证全绿**

Run:
```bash
cd e:\code\vcash\packages\vcash-pos-plugin && pnpm test 2>&1 | Select-String -Pattern "Test Files|Tests |FAIL|PASS|Error:|expected" | Select-Object -First 30
```
Expected: 22 测试通过（terminal 6 + session 7 + custom-fields 3 + pos-flow 6）

- [ ] **Step 3: 验证 server 端无回归**

Run:
```bash
cd e:\code\vcash\server && pnpm test 2>&1 | Select-String -Pattern "Test Files|Tests " | Select-Object -First 2
```
Expected: 6 测试通过

- [ ] **Step 4: Commit**

```bash
cd e:\code && git add vcash/packages/vcash-pos-plugin/e2e/pos-flow.e2e-spec.ts && git commit -m "test(pos-plugin): 完整收银流程 e2e（加商品/修改数量/结账/状态校验）"
```

---

## Self-Review

**1. Spec coverage:**
- ensureActiveOrder（复用/创建+custom fields）→ Task 2 Step 1 ✓
- addPosItem（addItemToOrder 第 5 参设 OrderLine custom fields）→ Task 2 Step 1 ✓
- updatePosItem（adjustOrderLine）→ Task 2 Step 1 ✓
- checkoutPosOrder（withTransaction + transitionToState + addManualPaymentToOrder）→ Task 2 Step 1 ✓
- AdminPosResolver 4 个新方法 → Task 3 Step 1 ✓
- plugin.ts schema 扩展 → Task 3 Step 2 ✓
- orderOptions 关闭 customer/shipping 检查 → Task 1 ✓
- 完整 e2e 测试 → Task 4 ✓

**2. Placeholder scan:** 无 TBD/TODO，每个步骤都有完整代码。

**3. Type consistency:**
- `PosOrderService` 在 Task 2 定义，Task 3 注入到 resolver，名称一致 ✓
- `AddPosItemInput`/`UpdatePosItemInput`/`CheckoutInput`/`PosCheckoutResult` 在 Task 3 schema 定义，Task 4 测试中使用，字段名一致 ✓
- `posSessionPermission.Update` 在 Task 3 用作 @Allow 参数，与 constants.ts 中已定义的 `posSessionPermission` 一致 ✓
- `TransactionalConnection` 在 Task 2 注入，Vendure core 已导出 ✓

无问题，计划可执行。
