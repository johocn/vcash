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

const posOrderProcess = configureDefaultOrderProcess({
  arrangingPaymentRequiresCustomer: false,
  arrangingPaymentRequiresShipping: false,
});

const GET_PRODUCTS = gql`
  query GetProducts {
    products {
      items { id name variants { id sku name price } }
    }
  }
`;

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
  mutation OpenSession($terminalCode: String!, $openingFloat: Int) {
    openSession(input: { terminalCode: $terminalCode, openingFloat: $openingFloat }) {
      id code state
    }
  }
`;

const CLOSE_SESSION = gql`
  mutation CloseSession($sessionId: ID!, $closingCash: Int) {
    closeSession(input: { sessionId: $sessionId, closingCash: $closingCash }) {
      session { id state }
    }
  }
`;

const ADD_POS_ITEM = gql`
  mutation AddPosItem($productVariantId: ID!, $quantity: Int!) {
    addPosItem(input: { productVariantId: $productVariantId, quantity: $quantity }) {
      id state total totalWithTax
    }
  }
`;

const POS_ACTIVE_ORDER = gql`
  query PosActiveOrder {
    posActiveOrder { id code state lines { id quantity } }
  }
`;

const HOLD_ORDER = gql`
  mutation HoldOrder { holdOrder { id code state } }
`;

const RESUME_ORDER = gql`
  mutation ResumeOrder($orderId: ID!) {
    resumeOrder(orderId: $orderId) { id code state }
  }
`;

const HELD_ORDERS = gql`
  query HeldOrders {
    heldOrders { id code state lines { id quantity } }
  }
`;

describe('挂单/取单流程', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin],
  });

  let variantId: string;
  let sessionId: string;
  let heldOrderId: string;
  const openingFloat = 50000;

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

    const productsRes = await adminClient.query(GET_PRODUCTS);
    expect(productsRes.products.items.length).toBeGreaterThan(0);
    variantId = productsRes.products.items[0].variants[0].id;

    // Terminal A（挂单主流程）
    const slA = await adminClient.query(CREATE_STOCK_LOCATION, { name: 'A' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-HR-001',
      name: '挂单测试台A',
      stockLocationId: slA.createStockLocation.id,
    });

    // Terminal B（跨终端取单场景）
    const slB = await adminClient.query(CREATE_STOCK_LOCATION, { name: 'B' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-HR-002',
      name: '挂单测试台B',
      stockLocationId: slB.createStockLocation.id,
    });

    const session = await adminClient.query(OPEN_SESSION, {
      terminalCode: 'POS-HR-001',
      openingFloat,
    });
    sessionId = session.openSession.id;
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('用例1: 挂单后 posActiveOrder 返回新空 Order', async () => {
    await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 2,
    });
    const before = await adminClient.query(POS_ACTIVE_ORDER);
    heldOrderId = before.posActiveOrder.id;

    await adminClient.query(HOLD_ORDER);

    const after = await adminClient.query(POS_ACTIVE_ORDER);
    expect(after.posActiveOrder.id).not.toBe(heldOrderId);
    expect(after.posActiveOrder.lines.length).toBe(0);
  });

  it('用例2: heldOrders 返回包含挂单的列表', async () => {
    const result = await adminClient.query(HELD_ORDERS);
    expect(result.heldOrders.length).toBe(1);
    expect(result.heldOrders[0].id).toBe(heldOrderId);
    expect(result.heldOrders[0].lines.length).toBe(1);
    expect(result.heldOrders[0].lines[0].quantity).toBe(2);
  });

  it('用例3: resumeOrder 把挂单加载回 activeOrder', async () => {
    await adminClient.query(RESUME_ORDER, { orderId: heldOrderId });

    const active = await adminClient.query(POS_ACTIVE_ORDER);
    expect(active.posActiveOrder.id).toBe(heldOrderId);
    expect(active.posActiveOrder.lines.length).toBe(1);
    expect(active.posActiveOrder.lines[0].quantity).toBe(2);

    const held = await adminClient.query(HELD_ORDERS);
    expect(held.heldOrders.length).toBe(0);
  });

  it('用例4: 跨终端取单被拒', async () => {
    // 用例3 后 activeOrder = heldOrderId（已取回，含 1 行 quantity=2）
    // 又加商品 + 再次挂单（同一 Order id，再次置为 hold）
    await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 1,
    });
    await adminClient.query(HOLD_ORDER);

    // 关闭 Terminal A 上的 session（session 记录保留，terminal 仍为 A）
    await adminClient.query(CLOSE_SESSION, {
      sessionId,
      closingCash: 0,
    });

    // 同一 superAdmin 在 Terminal B 开新班
    await adminClient.query(OPEN_SESSION, {
      terminalCode: 'POS-HR-002',
      openingFloat,
    });

    // 跨终端取单应被拒
    await expect(
      adminClient.query(RESUME_ORDER, { orderId: heldOrderId }),
    ).rejects.toThrow();
  });
});
