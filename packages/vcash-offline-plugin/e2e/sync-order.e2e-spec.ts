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

const UPDATE_VARIANT_STOCK = gql`
  mutation UpdateVariantStock($id: ID!, $trackInventory: GlobalFlag!, $outOfStockThreshold: Int, $useGlobalOutOfStockThreshold: Boolean) {
    updateProductVariants(input: [
      { id: $id, trackInventory: $trackInventory, outOfStockThreshold: $outOfStockThreshold, useGlobalOutOfStockThreshold: $useGlobalOutOfStockThreshold }
    ]) {
      ... on ProductVariant { id trackInventory outOfStockThreshold useGlobalOutOfStockThreshold }
    }
  }
`;

const SYNC_ORDERS = gql`
  mutation SyncOrders($orders: [OfflineOrderInput!]!) {
    syncOrders(input: { orders: $orders }) {
      succeeded {
        idempotencyKey
        orderId
        orderCode
        status
      }
      failed {
        idempotencyKey
        error
        code
        status
      }
    }
  }
`;

function buildOrderInput(opts: {
  idempotencyKey: string;
  variantId: string;
  quantity?: number;
  clientUpdatedAt?: string;
  clientCreatedAt?: string;
}): any {
  const now = new Date().toISOString();
  return {
    idempotencyKey: opts.idempotencyKey,
    clientCreatedAt: opts.clientCreatedAt ?? now,
    clientUpdatedAt: opts.clientUpdatedAt ?? now,
    sessionCode: 'S-OFFLINE-001',
    terminalCode: 'POS-OFFLINE-001',
    orderType: 'sale',
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

describe('离线订单同步 syncOrders', () => {
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

    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-OFFLINE-001',
      name: '离线收银台',
      stockLocationId: sl.createStockLocation.id,
    });

    const productsRes = await adminClient.query(GET_PRODUCTS);
    expect(productsRes.products.items.length).toBeGreaterThanOrEqual(2);
    variantIdA = productsRes.products.items[0].variants[0].id;
    variantIdB = productsRes.products.items[1].variants[0].id;
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('测试1: syncOrders 创建新订单 → success + orderId', async () => {
    const result = await adminClient.query(SYNC_ORDERS, {
      orders: [buildOrderInput({
        idempotencyKey: 'offline-order-001',
        variantId: variantIdA,
        quantity: 1,
      })],
    });
    const { succeeded, failed } = result.syncOrders;
    expect(failed.length).toBe(0);
    expect(succeeded.length).toBe(1);
    expect(succeeded[0].idempotencyKey).toBe('offline-order-001');
    expect(succeeded[0].status).toBe('success');
    expect(succeeded[0].orderId).toBeTruthy();
    expect(succeeded[0].orderCode).toBeTruthy();
  });

  it('测试2: 重复 syncOrders 同一 idempotencyKey → duplicate', async () => {
    const result = await adminClient.query(SYNC_ORDERS, {
      orders: [buildOrderInput({
        idempotencyKey: 'offline-order-001',
        variantId: variantIdA,
        quantity: 1,
      })],
    });
    const { succeeded, failed } = result.syncOrders;
    expect(failed.length).toBe(0);
    expect(succeeded.length).toBe(1);
    expect(succeeded[0].idempotencyKey).toBe('offline-order-001');
    expect(succeeded[0].status).toBe('duplicate');
    expect(succeeded[0].orderId).toBeTruthy();
  });

  it('测试3: 库存不足 → failed + OUT_OF_STOCK', async () => {
    // 设置 variantB trackInventory=TRUE + outOfStockThreshold=999999 + useGlobalOutOfStockThreshold=false → 任何下单都缺货
    await adminClient.query(UPDATE_VARIANT_STOCK, {
      id: variantIdB,
      trackInventory: 'TRUE',
      outOfStockThreshold: 999999,
      useGlobalOutOfStockThreshold: false,
    });

    const result = await adminClient.query(SYNC_ORDERS, {
      orders: [buildOrderInput({
        idempotencyKey: 'offline-order-oos',
        variantId: variantIdB,
        quantity: 1,
        clientUpdatedAt: '2026-08-01T10:00:00.000Z',
      })],
    });
    const { succeeded, failed } = result.syncOrders;
    expect(succeeded.length).toBe(0);
    expect(failed.length).toBe(1);
    expect(failed[0].idempotencyKey).toBe('offline-order-oos');
    expect(failed[0].code).toBe('OUT_OF_STOCK');
    expect(failed[0].status).toBe('failed');
  });

  it('测试4: LWW - failed + 更新 clientUpdatedAt → 重试成功', async () => {
    // 恢复 variantB 库存设置（关闭库存追踪）
    await adminClient.query(UPDATE_VARIANT_STOCK, {
      id: variantIdB,
      trackInventory: 'FALSE',
      outOfStockThreshold: 0,
      useGlobalOutOfStockThreshold: false,
    });

    // 同一 idempotencyKey，但 clientUpdatedAt 更新（更晚）→ 应重试成功
    const result = await adminClient.query(SYNC_ORDERS, {
      orders: [buildOrderInput({
        idempotencyKey: 'offline-order-oos',
        variantId: variantIdB,
        quantity: 1,
        clientCreatedAt: '2026-08-01T10:00:00.000Z',
        clientUpdatedAt: '2026-08-01T11:00:00.000Z', // 比测试3的时间更晚
      })],
    });
    const { succeeded, failed } = result.syncOrders;
    expect(failed.length).toBe(0);
    expect(succeeded.length).toBe(1);
    expect(succeeded[0].idempotencyKey).toBe('offline-order-oos');
    expect(succeeded[0].status).toBe('success');
    expect(succeeded[0].orderId).toBeTruthy();
    expect(succeeded[0].orderCode).toBeTruthy();
  });
});
