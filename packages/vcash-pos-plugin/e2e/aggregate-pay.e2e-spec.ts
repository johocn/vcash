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

const CREATE_AGGREGATE_PAY = gql`
  mutation CreateAggregatePay($aggregatePayCode: String!) {
    createAggregatePay(input: { aggregatePayCode: $aggregatePayCode }) {
      id
      amount
      state
      method
      customFields { aggregatePayCode aggregatePayStatus posSessionId }
    }
  }
`;

const CONFIRM_AGGREGATE_PAY = gql`
  mutation ConfirmAggregatePay($paymentId: ID!) {
    confirmAggregatePay(paymentId: $paymentId) {
      id
      state
      customFields { aggregatePayStatus }
    }
  }
`;

const SETTLE_AGGREGATE_PAY = gql`
  mutation SettleAggregatePay($paymentId: ID!) {
    settleAggregatePay(paymentId: $paymentId) {
      id
      state
      customFields { aggregatePayStatus }
    }
  }
`;

const FAIL_AGGREGATE_PAY = gql`
  mutation FailAggregatePay($paymentId: ID!) {
    failAggregatePay(paymentId: $paymentId) {
      id
      state
      customFields { aggregatePayStatus }
    }
  }
`;

const AGGREGATE_PAY_BY_CODE = gql`
  query AggregatePayByCode($aggregatePayCode: String!) {
    aggregatePayByCode(aggregatePayCode: $aggregatePayCode) {
      id
      state
      method
      customFields { aggregatePayCode aggregatePayStatus }
      order { id state }
    }
  }
`;

const POS_ACTIVE_ORDER = gql`
  query PosActiveOrder {
    posActiveOrder {
      id
      state
      total
      lines { id quantity }
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

describe('聚合码支付流程', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin],
  });

  let variantId: string;
  let sessionId: string;
  let paymentId: string;
  let orderTotal: number;

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

    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-AGG-001',
      name: '1号收银台',
      stockLocationId: sl.createStockLocation.id,
    });

    const session = await adminClient.query(OPEN_SESSION, {
      terminalCode: 'POS-AGG-001',
    });
    sessionId = session.openSession.id;
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应加商品到购物车', async () => {
    const result = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 2,
    });
    expect(result.addPosItem.state).toBe('AddingItems');
    orderTotal = result.addPosItem.totalWithTax;
    expect(orderTotal).toBeGreaterThan(0);
  });

  it('应创建聚合码待支付 Payment（state=Created, aggregatePayStatus=pending）', async () => {
    const result = await adminClient.query(CREATE_AGGREGATE_PAY, {
      aggregatePayCode: 'AGG-TEST-001',
    });
    const payment = result.createAggregatePay;
    expect(payment.state).toBe('Created');
    expect(payment.method).toBe('aggregate');
    expect(payment.customFields.aggregatePayCode).toBe('AGG-TEST-001');
    expect(payment.customFields.aggregatePayStatus).toBe('pending');
    expect(payment.amount).toBe(orderTotal);
    paymentId = payment.id;
  });

  it('aggregatePayByCode 应能查到 pending 状态的 Payment', async () => {
    const result = await adminClient.query(AGGREGATE_PAY_BY_CODE, {
      aggregatePayCode: 'AGG-TEST-001',
    });
    expect(result.aggregatePayByCode).toBeTruthy();
    expect(result.aggregatePayByCode.state).toBe('Created');
    expect(result.aggregatePayByCode.customFields.aggregatePayStatus).toBe('pending');
    // Order 应处于 ArrangingPayment
    expect(result.aggregatePayByCode.order.state).toBe('ArrangingPayment');
  });

  it('应确认聚合码支付（Created → Authorized, aggregatePayStatus → confirmed）', async () => {
    const result = await adminClient.query(CONFIRM_AGGREGATE_PAY, {
      paymentId,
    });
    expect(result.confirmAggregatePay.state).toBe('Authorized');
    expect(result.confirmAggregatePay.customFields.aggregatePayStatus).toBe('confirmed');
  });

  it('确认后 Order 应处于 PaymentAuthorized', async () => {
    const result = await adminClient.query(AGGREGATE_PAY_BY_CODE, {
      aggregatePayCode: 'AGG-TEST-001',
    });
    expect(result.aggregatePayByCode.order.state).toBe('PaymentAuthorized');
  });

  it('应结算聚合码支付（Authorized → Settled, aggregatePayStatus → settled）', async () => {
    const result = await adminClient.query(SETTLE_AGGREGATE_PAY, {
      paymentId,
    });
    expect(result.settleAggregatePay.state).toBe('Settled');
    expect(result.settleAggregatePay.customFields.aggregatePayStatus).toBe('settled');
  });

  it('结算后 Order 应处于 PaymentSettled', async () => {
    const result = await adminClient.query(AGGREGATE_PAY_BY_CODE, {
      aggregatePayCode: 'AGG-TEST-001',
    });
    expect(result.aggregatePayByCode.order.state).toBe('PaymentSettled');
  });

  it('结算后 posActiveOrder 应为新的空购物车', async () => {
    const result = await adminClient.query(POS_ACTIVE_ORDER);
    expect(result.posActiveOrder).toBeTruthy();
    expect(result.posActiveOrder.lines.length).toBe(0);
  });
});

describe('聚合码支付失败流程', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin],
  });

  let variantId: string;
  let paymentId: string;

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
    variantId = productsRes.products.items[0].variants[0].id;

    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-AGG-FAIL',
      name: '失败测试台',
      stockLocationId: sl.createStockLocation.id,
    });

    await adminClient.query(OPEN_SESSION, {
      terminalCode: 'POS-AGG-FAIL',
    });

    await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 1,
    });
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应创建待支付 Payment', async () => {
    const result = await adminClient.query(CREATE_AGGREGATE_PAY, {
      aggregatePayCode: 'AGG-FAIL-001',
    });
    expect(result.createAggregatePay.state).toBe('Created');
    paymentId = result.createAggregatePay.id;
  });

  it('应标记支付失败（Created → Cancelled, aggregatePayStatus → failed）', async () => {
    const result = await adminClient.query(FAIL_AGGREGATE_PAY, {
      paymentId,
    });
    expect(result.failAggregatePay.state).toBe('Cancelled');
    expect(result.failAggregatePay.customFields.aggregatePayStatus).toBe('failed');
  });

  it('失败后 Order 应退回 AddingItems', async () => {
    const result = await adminClient.query(POS_ACTIVE_ORDER);
    expect(result.posActiveOrder).toBeTruthy();
    expect(result.posActiveOrder.state).toBe('AddingItems');
    // 购物车内容应保留
    expect(result.posActiveOrder.lines.length).toBe(1);
  });

  it('对非 Created 状态的 Payment 调 failAggregatePay 应报错', async () => {
    await expect(
      adminClient.query(FAIL_AGGREGATE_PAY, { paymentId }),
    ).rejects.toThrow();
  });
});
