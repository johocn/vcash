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

import { VcashPosPlugin } from '@vcash/pos-plugin';
import { VcashOfflinePlugin } from '../src/plugin';

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

const GET_PRODUCTS = gql`
  query GetProducts {
    products {
      items {
        id
        name
        variants { id sku name price }
      }
    }
  }
`;

const CREATE_CUSTOMER = gql`
  mutation CreateCustomer($input: CreateCustomerInput!) {
    createCustomer(input: $input) {
      ... on Customer {
        id
        firstName
        lastName
        emailAddress
      }
      ... on ErrorResult {
        errorCode
        message
      }
    }
  }
`;

const SYNC_ORDERS = gql`
  mutation SyncOrders($orders: [OfflineOrderInput!]!) {
    syncOrders(input: { orders: $orders }) {
      succeeded { idempotencyKey orderId orderCode status }
      failed { idempotencyKey error code status }
    }
  }
`;

const SYNC_PAYMENTS = gql`
  mutation SyncPayments($payments: [OfflinePaymentSyncInput!]!) {
    syncPayments(input: { payments: $payments }) {
      succeeded { idempotencyKey paymentId orderId status }
      failed { idempotencyKey error code status }
    }
  }
`;

const SYNC_SESSIONS = gql`
  mutation SyncSessions($sessions: [OfflineSessionInput!]!) {
    syncSessions(input: { sessions: $sessions }) {
      succeeded { idempotencyKey sessionId sessionCode state status }
      failed { idempotencyKey error code status }
    }
  }
`;

const SYNC_PRODUCTS = gql`
  query SyncProducts($since: DateTime!, $limit: Int!) {
    syncProducts(since: $since, limit: $limit) {
      items {
        variantId
        sku
        name
        price
        priceWithTax
        barcode
        categoryId
        updatedAt
      }
      cursor
    }
  }
`;

const SYNC_MEMBERS = gql`
  query SyncMembers($since: DateTime!, $limit: Int!) {
    syncMembers(since: $since, limit: $limit) {
      items {
        customerId
        emailAddress
        firstName
        lastName
        customFields { memberLevel points }
        updatedAt
      }
      cursor
    }
  }
`;

function buildOrderInput(opts: {
  idempotencyKey: string;
  variantId: string;
  sessionCode?: string;
  terminalCode?: string;
}): any {
  const now = new Date().toISOString();
  return {
    idempotencyKey: opts.idempotencyKey,
    clientCreatedAt: now,
    clientUpdatedAt: now,
    sessionCode: opts.sessionCode ?? 'S-OFFLINE-INC-001',
    terminalCode: opts.terminalCode ?? 'POS-INC-001',
    orderType: 'sale',
    lines: [
      {
        productVariantId: opts.variantId,
        quantity: 1,
        discount: 100,
      },
    ],
    payments: [{ method: 'cash' }],
    totalAmount: 1000,
  };
}

describe('增量同步 + syncPayments + syncSessions', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin, VcashOfflinePlugin],
  });

  let variantId: string;
  let customerId: string;

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

    // 创建两个终端：一个用于订单/支付测试，一个用于班次测试
    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '增量同步门店' });
    const stockLocationId = sl.createStockLocation.id;
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-INC-001',
      name: '增量同步收银台',
      stockLocationId,
    });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-INC-SESS',
      name: '班次同步收银台',
      stockLocationId,
    });

    // 获取商品 variant
    const productsRes = await adminClient.query(GET_PRODUCTS);
    expect(productsRes.products.items.length).toBeGreaterThanOrEqual(1);
    variantId = productsRes.products.items[0].variants[0].id;

    // 创建一个 Customer 用于 syncMembers 测试
    const custRes = await adminClient.query(CREATE_CUSTOMER, {
      input: {
        firstName: '三',
        lastName: '张',
        emailAddress: 'member-inc@test.com',
      },
    });
    customerId = custRes.createCustomer.id;
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('测试1: syncProducts 增量返回商品 + cursor 推进', async () => {
    // 用 epoch 作为 since，拉取全部商品
    const res1 = await adminClient.query(SYNC_PRODUCTS, {
      since: '1970-01-01T00:00:00.000Z',
      limit: 100,
    });
    expect(res1.syncProducts.items.length).toBeGreaterThanOrEqual(1);
    expect(res1.syncProducts.cursor).toBeTruthy();

    // 每条 item 必填字段校验
    for (const item of res1.syncProducts.items) {
      expect(item.variantId).toBeTruthy();
      expect(item.sku).toBeTruthy();
      expect(item.name).toBeTruthy();
      expect(typeof item.price).toBe('number');
      expect(typeof item.priceWithTax).toBe('number');
      expect(item.updatedAt).toBeTruthy();
    }

    // 用 cursor 作为 since 再次拉取 → 应无新增
    const res2 = await adminClient.query(SYNC_PRODUCTS, {
      since: res1.syncProducts.cursor,
      limit: 100,
    });
    expect(res2.syncProducts.items.length).toBe(0);
    expect(res2.syncProducts.cursor).toBe(res1.syncProducts.cursor);
  });

  it('测试2: syncMembers 增量返回会员 + cursor 推进', async () => {
    const res1 = await adminClient.query(SYNC_MEMBERS, {
      since: '1970-01-01T00:00:00.000Z',
      limit: 100,
    });
    expect(res1.syncMembers.items.length).toBeGreaterThanOrEqual(1);

    // 校验至少包含前面创建的会员
    const found = res1.syncMembers.items.find(
      (m: any) => m.emailAddress === 'member-inc@test.com',
    );
    expect(found).toBeTruthy();
    expect(found.firstName).toBe('三');
    expect(found.lastName).toBe('张');
    expect(found.customFields).toBeTruthy();
    expect(typeof found.customFields.memberLevel).toBe('number');
    expect(typeof found.customFields.points).toBe('number');

    // cursor 推进
    const res2 = await adminClient.query(SYNC_MEMBERS, {
      since: res1.syncMembers.cursor,
      limit: 100,
    });
    expect(res2.syncMembers.items.length).toBe(0);
    expect(res2.syncMembers.cursor).toBe(res1.syncMembers.cursor);
  });

  it('测试3: syncPayments 幂等 - 同一 idempotencyKey 重复同步 → duplicate', async () => {
    // 先同步一笔订单（syncPayments 依赖已同步的 Order）
    const orderKey = 'offline-order-for-payment';
    const orderRes = await adminClient.query(SYNC_ORDERS, {
      orders: [buildOrderInput({
        idempotencyKey: orderKey,
        variantId,
      })],
    });
    expect(orderRes.syncOrders.succeeded.length).toBe(1);
    expect(orderRes.syncOrders.succeeded[0].status).toBe('success');

    // 第一次 syncPayments → success
    const payRes1 = await adminClient.query(SYNC_PAYMENTS, {
      payments: [{
        idempotencyKey: 'offline-payment-inc-001',
        clientCreatedAt: new Date().toISOString(),
        clientUpdatedAt: new Date().toISOString(),
        orderKey,
        method: 'wechat',
        amount: 500,
        transactionId: 'wx-tx-001',
        metadata: { source: 'offline' },
      }],
    });
    expect(payRes1.syncPayments.failed.length).toBe(0);
    expect(payRes1.syncPayments.succeeded.length).toBe(1);
    expect(payRes1.syncPayments.succeeded[0].idempotencyKey).toBe('offline-payment-inc-001');
    expect(payRes1.syncPayments.succeeded[0].status).toBe('success');
    expect(payRes1.syncPayments.succeeded[0].paymentId).toBeTruthy();
    expect(payRes1.syncPayments.succeeded[0].orderId).toBeTruthy();

    // 第二次 syncPayments 同一 idempotencyKey → duplicate
    const payRes2 = await adminClient.query(SYNC_PAYMENTS, {
      payments: [{
        idempotencyKey: 'offline-payment-inc-001',
        clientCreatedAt: new Date().toISOString(),
        clientUpdatedAt: new Date().toISOString(),
        orderKey,
        method: 'wechat',
        amount: 500,
        transactionId: 'wx-tx-001',
        metadata: { source: 'offline' },
      }],
    });
    expect(payRes2.syncPayments.failed.length).toBe(0);
    expect(payRes2.syncPayments.succeeded.length).toBe(1);
    expect(payRes2.syncPayments.succeeded[0].idempotencyKey).toBe('offline-payment-inc-001');
    expect(payRes2.syncPayments.succeeded[0].status).toBe('duplicate');
  });

  it('测试4: syncSessions 创建 + 关闭班次', async () => {
    const now = new Date().toISOString();
    const res = await adminClient.query(SYNC_SESSIONS, {
      sessions: [{
        idempotencyKey: 'offline-session-inc-001',
        clientCreatedAt: now,
        clientUpdatedAt: now,
        sessionCode: 'OFFLINE-SESS-INC-001',
        terminalCode: 'POS-INC-SESS',
        operatorId: '1',
        openingFloat: 10000,
        state: 'closed',
        closingCash: 10000,
      }],
    });
    expect(res.syncSessions.failed.length).toBe(0);
    expect(res.syncSessions.succeeded.length).toBe(1);
    const sess = res.syncSessions.succeeded[0];
    expect(sess.idempotencyKey).toBe('offline-session-inc-001');
    expect(sess.status).toBe('success');
    expect(sess.sessionId).toBeTruthy();
    expect(sess.sessionCode).toBeTruthy();
    // state='closed' → 离线记录要求开班后立即关班
    expect(sess.state).toBe('closed');

    // 重复同步同一 idempotencyKey → duplicate
    const res2 = await adminClient.query(SYNC_SESSIONS, {
      sessions: [{
        idempotencyKey: 'offline-session-inc-001',
        clientCreatedAt: now,
        clientUpdatedAt: now,
        sessionCode: 'OFFLINE-SESS-INC-001',
        terminalCode: 'POS-INC-SESS',
        operatorId: '1',
        openingFloat: 10000,
        state: 'closed',
        closingCash: 10000,
      }],
    });
    expect(res2.syncSessions.failed.length).toBe(0);
    expect(res2.syncSessions.succeeded.length).toBe(1);
    expect(res2.syncSessions.succeeded[0].status).toBe('duplicate');
  });
});
