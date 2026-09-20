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
      items { id name variants { id sku name price } }
    }
  }
`;

const UPDATE_VARIANT_STOCK = gql`
  mutation UpdateVariantStock($id: ID!, $trackInventory: GlobalFlag!, $outOfStockThreshold: Int, $useGlobalOutOfStockThreshold: Boolean) {
    updateProductVariants(input: [
      { id: $id, trackInventory: $trackInventory, outOfStockThreshold: $outOfStockThreshold, useGlobalOutOfStockThreshold: $useGlobalOutOfStockThreshold }
    ]) {
      ... on ProductVariant { id trackInventory }
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

function buildOrderInput(opts: {
  idempotencyKey: string;
  variantId: string;
  quantity?: number;
  sessionCode?: string;
  terminalCode?: string;
  clientUpdatedAt?: string;
  clientCreatedAt?: string;
  orderType?: string;
}): any {
  const now = new Date().toISOString();
  return {
    idempotencyKey: opts.idempotencyKey,
    clientCreatedAt: opts.clientCreatedAt ?? now,
    clientUpdatedAt: opts.clientUpdatedAt ?? now,
    sessionCode: opts.sessionCode ?? 'S-EDGE-001',
    terminalCode: opts.terminalCode ?? 'POS-EDGE-001',
    orderType: opts.orderType ?? 'sale',
    lines: [
      {
        productVariantId: opts.variantId,
        quantity: opts.quantity ?? 1,
        discount: 100,
      },
    ],
    payments: [{ method: 'cash' }],
    totalAmount: 1000,
  };
}

/**
 * 离线同步边界场景测试：
 * 1. 批量同步 mixed success/failure
 * 2. syncSessions open 状态（只开班不关班）
 * 3. CONFLICT 场景（stale clientUpdatedAt）
 * 4. syncPayments ORDER_NOT_SYNCED
 * 5. syncPayments LWW 重试成功
 */
describe('离线同步边界场景', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin, VcashOfflinePlugin],
  });

  let variantIdA: string;
  let variantIdB: string;

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

    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '边界场景门店' });
    const stockLocationId = sl.createStockLocation.id;
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-EDGE-001',
      name: '边界场景收银台',
      stockLocationId,
    });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-EDGE-SESS',
      name: '班次边界收银台',
      stockLocationId,
    });

    const productsRes = await adminClient.query(GET_PRODUCTS);
    expect(productsRes.products.items.length).toBeGreaterThanOrEqual(2);
    variantIdA = productsRes.products.items[0].variants[0].id;
    variantIdB = productsRes.products.items[1].variants[0].id;
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('测试1: 批量同步 - 一个成功一个库存不足失败', async () => {
    // variantB 设置高阈值 → 任何下单都缺货
    await adminClient.query(UPDATE_VARIANT_STOCK, {
      id: variantIdB,
      trackInventory: 'TRUE',
      outOfStockThreshold: 999999,
      useGlobalOutOfStockThreshold: false,
    });

    const result = await adminClient.query(SYNC_ORDERS, {
      orders: [
        // 第 1 笔：variantA，正常成功
        buildOrderInput({
          idempotencyKey: 'edge-batch-ok',
          variantId: variantIdA,
          quantity: 1,
        }),
        // 第 2 笔：variantB，库存不足失败
        buildOrderInput({
          idempotencyKey: 'edge-batch-oos',
          variantId: variantIdB,
          quantity: 1,
        }),
      ],
    });

    expect(result.syncOrders.succeeded.length).toBe(1);
    expect(result.syncOrders.failed.length).toBe(1);
    expect(result.syncOrders.succeeded[0].idempotencyKey).toBe('edge-batch-ok');
    expect(result.syncOrders.succeeded[0].status).toBe('success');
    expect(result.syncOrders.failed[0].idempotencyKey).toBe('edge-batch-oos');
    expect(result.syncOrders.failed[0].code).toBe('OUT_OF_STOCK');
    expect(result.syncOrders.failed[0].status).toBe('failed');
  });

  it('测试2: CONFLICT - failed 后用更旧的 clientUpdatedAt 重试 → CONFLICT', async () => {
    // edge-batch-oos 已 failed，用更旧的 clientUpdatedAt 重试 → CONFLICT
    const result = await adminClient.query(SYNC_ORDERS, {
      orders: [buildOrderInput({
        idempotencyKey: 'edge-batch-oos',
        variantId: variantIdB,
        quantity: 1,
        clientCreatedAt: '2026-08-01T10:00:00.000Z',
        clientUpdatedAt: '2026-08-01T09:00:00.000Z', // 比测试1的 now 更旧
      })],
    });

    expect(result.syncOrders.succeeded.length).toBe(0);
    expect(result.syncOrders.failed.length).toBe(1);
    expect(result.syncOrders.failed[0].idempotencyKey).toBe('edge-batch-oos');
    expect(result.syncOrders.failed[0].code).toBe('CONFLICT');
    expect(result.syncOrders.failed[0].status).toBe('failed');
  });

  it('测试3: syncSessions open 状态 - 只开班不关班', async () => {
    const now = new Date().toISOString();
    const result = await adminClient.query(SYNC_SESSIONS, {
      sessions: [{
        idempotencyKey: 'edge-session-open-001',
        clientCreatedAt: now,
        clientUpdatedAt: now,
        sessionCode: 'EDGE-SESS-OPEN-001',
        terminalCode: 'POS-EDGE-SESS',
        operatorId: '1',
        openingFloat: 5000,
        state: 'open', // 只开班，不关班
      }],
    });

    expect(result.syncSessions.failed.length).toBe(0);
    expect(result.syncSessions.succeeded.length).toBe(1);
    const sess = result.syncSessions.succeeded[0];
    expect(sess.idempotencyKey).toBe('edge-session-open-001');
    expect(sess.status).toBe('success');
    expect(sess.state).toBe('open');
    expect(sess.sessionId).toBeTruthy();
    expect(sess.sessionCode).toBeTruthy();
  });

  it('测试4: syncPayments ORDER_NOT_SYNCED - 关联订单未同步', async () => {
    const now = new Date().toISOString();
    const result = await adminClient.query(SYNC_PAYMENTS, {
      payments: [{
        idempotencyKey: 'edge-payment-no-order',
        clientCreatedAt: now,
        clientUpdatedAt: now,
        orderKey: 'non-existent-order-key',
        method: 'wechat',
        amount: 500,
        transactionId: 'wx-no-order-001',
        metadata: { source: 'edge-test' },
      }],
    });

    expect(result.syncPayments.succeeded.length).toBe(0);
    expect(result.syncPayments.failed.length).toBe(1);
    expect(result.syncPayments.failed[0].idempotencyKey).toBe('edge-payment-no-order');
    expect(result.syncPayments.failed[0].code).toBe('ORDER_NOT_SYNCED');
    expect(result.syncPayments.failed[0].status).toBe('failed');
  });

  it('测试5: syncPayments LWW 重试 - failed 后更新 clientUpdatedAt → success', async () => {
    // 测试4 已 failed，用更新的 clientUpdatedAt 重试 → 应重新处理
    // 但测试4 的 orderKey 不存在，所以需要换一个有效的 orderKey
    // 先同步一笔订单
    const orderKey = 'edge-payment-lww-order';
    const orderRes = await adminClient.query(SYNC_ORDERS, {
      orders: [buildOrderInput({
        idempotencyKey: orderKey,
        variantId: variantIdA,
        quantity: 1,
        sessionCode: 'S-EDGE-PAY-001',
      })],
    });
    expect(orderRes.syncOrders.succeeded.length).toBe(1);

    // 用 edge-payment-no-order 的 idempotencyKey 但改 orderKey 为有效的
    // 先让第一次 syncPayments failed（用不存在的 orderKey）
    const now = new Date().toISOString();
    const failedRes = await adminClient.query(SYNC_PAYMENTS, {
      payments: [{
        idempotencyKey: 'edge-payment-lww-001',
        clientCreatedAt: '2026-08-01T10:00:00.000Z',
        clientUpdatedAt: '2026-08-01T10:00:00.000Z',
        orderKey: 'non-existent-order-key-2',
        method: 'wechat',
        amount: 500,
        transactionId: 'wx-lww-001',
        metadata: { source: 'lww-test' },
      }],
    });
    expect(failedRes.syncPayments.failed.length).toBe(1);
    expect(failedRes.syncPayments.failed[0].code).toBe('ORDER_NOT_SYNCED');

    // LWW 重试：用更新的 clientUpdatedAt + 有效的 orderKey
    const retryRes = await adminClient.query(SYNC_PAYMENTS, {
      payments: [{
        idempotencyKey: 'edge-payment-lww-001',
        clientCreatedAt: '2026-08-01T10:00:00.000Z',
        clientUpdatedAt: '2026-08-01T11:00:00.000Z', // 更新
        orderKey, // 有效 orderKey
        method: 'wechat',
        amount: 500,
        transactionId: 'wx-lww-001',
        metadata: { source: 'lww-test' },
      }],
    });

    expect(retryRes.syncPayments.failed.length).toBe(0);
    expect(retryRes.syncPayments.succeeded.length).toBe(1);
    expect(retryRes.syncPayments.succeeded[0].idempotencyKey).toBe('edge-payment-lww-001');
    expect(retryRes.syncPayments.succeeded[0].status).toBe('success');
    expect(retryRes.syncPayments.succeeded[0].paymentId).toBeTruthy();
    expect(retryRes.syncPayments.succeeded[0].orderId).toBeTruthy();
  });
});
