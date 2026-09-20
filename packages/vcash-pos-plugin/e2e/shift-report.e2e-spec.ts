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
  mutation OpenSession($terminalCode: String!, $openingFloat: Int) {
    openSession(input: { terminalCode: $terminalCode, openingFloat: $openingFloat }) {
      id code state openingFloat
    }
  }
`;

const ADD_POS_ITEM = gql`
  mutation AddPosItem($productVariantId: ID!, $quantity: Int!) {
    addPosItem(input: { productVariantId: $productVariantId, quantity: $quantity }) {
      id state total
    }
  }
`;

const CHECKOUT = gql`
  mutation Checkout($payments: [CheckoutPaymentInput!]!) {
    checkoutPosOrder(input: { payments: $payments }) {
      order { id code state total payments { id amount state method } }
    }
  }
`;

const SHIFT_REPORT_PREVIEW = gql`
  query ShiftReportPreview($sessionId: ID!, $closingCash: Int) {
    shiftReportPreview(sessionId: $sessionId, closingCash: $closingCash)
  }
`;

const CLOSE_SESSION = gql`
  mutation CloseSession($sessionId: ID!, $closingCash: Int) {
    closeSession(input: { sessionId: $sessionId, closingCash: $closingCash }) {
      session { id state closingCash closeSummary activeOrderId }
      summary
    }
  }
`;

const GET_PRODUCTS = gql`
  query GetProducts {
    products {
      items { id name variants { id sku name price } }
    }
  }
`;

describe('ShiftReportService 交班对账', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin],
  });

  let variantId: string;
  let sessionId: string;
  let firstOrderTotal: number;
  let secondOrderTotal: number;
  const openingFloat = 50000; // 500 元（分）

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

    // 取商品 variant
    const productsRes = await adminClient.query(GET_PRODUCTS);
    expect(productsRes.products.items.length).toBeGreaterThan(0);
    variantId = productsRes.products.items[0].variants[0].id;

    // 创建 StockLocation + Terminal
    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-RPT-001',
      name: '1号收银台',
      stockLocationId: sl.createStockLocation.id,
    });

    // 开班，备 500 元零钱
    const session = await adminClient.query(OPEN_SESSION, {
      terminalCode: 'POS-RPT-001',
      openingFloat,
    });
    sessionId = session.openSession.id;
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应完成第一笔现金结账', async () => {
    await adminClient.query(ADD_POS_ITEM, { productVariantId: variantId, quantity: 2 });
    const result = await adminClient.query(CHECKOUT, {
      payments: [{ method: 'cash' }],
    });
    firstOrderTotal = result.checkoutPosOrder.order.total;
    expect(result.checkoutPosOrder.order.state).toBe('PaymentSettled');
    expect(firstOrderTotal).toBeGreaterThan(0);
  });

  it('应完成第二笔现金结账', async () => {
    await adminClient.query(ADD_POS_ITEM, { productVariantId: variantId, quantity: 1 });
    const result = await adminClient.query(CHECKOUT, {
      payments: [{ method: 'cash' }],
    });
    secondOrderTotal = result.checkoutPosOrder.order.total;
    expect(result.checkoutPosOrder.order.state).toBe('PaymentSettled');
    expect(secondOrderTotal).toBeGreaterThan(0);
  });

  it('shiftReportPreview 不传 closingCash 时应返回统计且无 warnings', async () => {
    const result = await adminClient.query(SHIFT_REPORT_PREVIEW, { sessionId });
    const summary = result.shiftReportPreview;
    expect(summary).toBeTruthy();
    expect(summary.orders.totalCount).toBe(2);
    expect(summary.orders.normalCount).toBe(2);
    expect(summary.orders.refundCount).toBe(0);
    expect(summary.orders.heldCount).toBe(0);
    expect(summary.orders.totalAmount).toBe(firstOrderTotal + secondOrderTotal);
    // 两笔现金支付
    expect(summary.paymentsByMethod.length).toBe(1);
    expect(summary.paymentsByMethod[0].method).toBe('cash');
    expect(summary.paymentsByMethod[0].count).toBe(2);
    expect(summary.paymentsByMethod[0].amount).toBe(firstOrderTotal + secondOrderTotal);
    // 未传 closingCash，不做现金对账
    expect(summary.warnings).toEqual([]);
  });

  it('shiftReportPreview 传入匹配的 closingCash 应无 warnings', async () => {
    // 应交现金 = openingFloat + 两笔现金支付总额
    const expectedCash = openingFloat + firstOrderTotal + secondOrderTotal;
    const result = await adminClient.query(SHIFT_REPORT_PREVIEW, {
      sessionId,
      closingCash: expectedCash,
    });
    const summary = result.shiftReportPreview;
    expect(summary.warnings).toEqual([]);
  });

  it('shiftReportPreview 传入不匹配的 closingCash 应产生 warning', async () => {
    const expectedCash = openingFloat + firstOrderTotal + secondOrderTotal;
    // 故意少交 100 分（1 元）
    const shortCash = expectedCash - 100;
    const result = await adminClient.query(SHIFT_REPORT_PREVIEW, {
      sessionId,
      closingCash: shortCash,
    });
    const summary = result.shiftReportPreview;
    expect(summary.warnings.length).toBe(1);
    expect(summary.warnings[0]).toContain('短');
  });

  it('关班时应自动生成 closeSummary 并持久化', async () => {
    const expectedCash = openingFloat + firstOrderTotal + secondOrderTotal;
    const result = await adminClient.query(CLOSE_SESSION, {
      sessionId,
      closingCash: expectedCash,
    });
    expect(result.closeSession.session.state).toBe('closed');
    expect(result.closeSession.session.closingCash).toBe(expectedCash);
    expect(result.closeSession.session.activeOrderId).toBeNull();
    // closeSummary 自动生成
    expect(result.closeSession.session.closeSummary).not.toBeNull();
    expect(result.closeSession.summary).not.toBeNull();
    expect(result.closeSession.summary.orders.totalCount).toBe(2);
    expect(result.closeSession.summary.orders.normalCount).toBe(2);
    expect(result.closeSession.summary.paymentsByMethod[0].method).toBe('cash');
    // closingCash 匹配，无 warnings
    expect(result.closeSession.summary.warnings).toEqual([]);
  });
});
