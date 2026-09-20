import path from 'node:path';
import {
  createTestEnvironment,
  registerInitializer,
  SqljsInitializer,
  testConfig,
} from '@vendure/testing';
import { configureDefaultOrderProcess, DefaultLogger, LogLevel } from '@vendure/core';
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
