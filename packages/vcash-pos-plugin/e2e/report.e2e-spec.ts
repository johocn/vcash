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
  mutation OpenSession($terminalCode: String!, $openingFloat: Int) {
    openSession(input: { terminalCode: $terminalCode, openingFloat: $openingFloat }) {
      id code state
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

const GET_PRODUCTS = gql`
  query GetProducts {
    products {
      items { id name variants { id sku name price } }
    }
  }
`;

const TODAY_OVERVIEW = gql`
  query TodayOverview {
    todayOverview {
      date
      totalAmount
      orderCount
      avgOrderValue
      refundAmount
      refundCount
      paymentsByMethod { method count amount }
    }
  }
`;

const SALES_REPORT = gql`
  query SalesReport($startDate: String!, $endDate: String!) {
    salesReport(startDate: $startDate, endDate: $endDate) {
      startDate
      endDate
      totalAmount
      totalOrders
      avgOrderValue
      daily { date totalAmount orderCount avgOrderValue }
    }
  }
`;

const MONTHLY_REPORT = gql`
  query MonthlyReport($year: Int!, $month: Int!) {
    monthlyReport(year: $year, month: $month) {
      year
      month
      totalAmount
      orderCount
      avgOrderValue
      prevMonth { totalAmount orderCount }
      amountChangeRate
      countChangeRate
    }
  }
`;

const TOP_PRODUCTS = gql`
  query TopProducts($startDate: String!, $endDate: String!, $limit: Int, $sortBy: String) {
    topProducts(startDate: $startDate, endDate: $endDate, limit: $limit, sortBy: $sortBy) {
      startDate
      endDate
      items { variantId variantName productName sku totalQuantity totalAmount }
    }
  }
`;

/**
 * 报表系统 e2e：店长/老板维度全店数据查询。
 *
 * 数据准备：
 * - 1 个 StockLocation + 1 个 Terminal + 1 个 Session
 * - 3 笔销售订单（2 笔现金 + 1 笔其他方式），全部 PaymentSettled
 * - 测试 4 个报表 Query
 */
describe('ReportService 报表系统', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin],
  });

  let variantId: string;
  let variantId2: string;
  let orderTotals: number[] = [];
  const openingFloat = 0;

  // 今日日期字符串（YYYY-MM-DD）
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

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

    // 取两个商品 variant（用于 TOP 排行验证）
    const productsRes = await adminClient.query(GET_PRODUCTS);
    expect(productsRes.products.items.length).toBeGreaterThanOrEqual(1);
    const product = productsRes.products.items[0];
    variantId = product.variants[0].id;
    variantId2 = product.variants[1]?.id ?? product.variants[0].id;

    // 创建 StockLocation + Terminal + 开班
    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-RPT-002',
      name: '报表测试收银台',
      stockLocationId: sl.createStockLocation.id,
    });
    await adminClient.query(OPEN_SESSION, {
      terminalCode: 'POS-RPT-002',
      openingFloat,
    });

    // 创建 3 笔销售订单：2 笔现金 + 1 笔其他方式
    // 第 1 笔：variant1 x 2，现金
    await adminClient.query(ADD_POS_ITEM, { productVariantId: variantId, quantity: 2 });
    let r = await adminClient.query(CHECKOUT, { payments: [{ method: 'cash' }] });
    expect(r.checkoutPosOrder.order.state).toBe('PaymentSettled');
    orderTotals.push(r.checkoutPosOrder.order.total);

    // 第 2 笔：variant2 x 1，cash
    await adminClient.query(ADD_POS_ITEM, { productVariantId: variantId2, quantity: 1 });
    r = await adminClient.query(CHECKOUT, { payments: [{ method: 'cash' }] });
    expect(r.checkoutPosOrder.order.state).toBe('PaymentSettled');
    orderTotals.push(r.checkoutPosOrder.order.total);

    // 第 3 笔：variant1 x 3，其他支付方式（mock 为 'wechat'）
    await adminClient.query(ADD_POS_ITEM, { productVariantId: variantId, quantity: 3 });
    r = await adminClient.query(CHECKOUT, { payments: [{ method: 'wechat' }] });
    expect(r.checkoutPosOrder.order.state).toBe('PaymentSettled');
    orderTotals.push(r.checkoutPosOrder.order.total);
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('todayOverview 应返回今日销售额/订单数/支付方式汇总', async () => {
    const res = await adminClient.query(TODAY_OVERVIEW);
    const ov = res.todayOverview;
    expect(ov).toBeTruthy();
    expect(ov.date).toBe(todayStr);
    expect(ov.orderCount).toBe(3);
    expect(ov.totalAmount).toBe(orderTotals.reduce((s, v) => s + v, 0));
    expect(ov.avgOrderValue).toBe(Math.round(ov.totalAmount / 3));
    // 今日无退款
    expect(ov.refundAmount).toBe(0);
    expect(ov.refundCount).toBe(0);
    // 支付方式汇总：cash x 2, wechat x 1
    const methods = ov.paymentsByMethod;
    expect(methods.length).toBe(2);
    const cash = methods.find((m: any) => m.method === 'cash');
    const wechat = methods.find((m: any) => m.method === 'wechat');
    expect(cash).toBeTruthy();
    expect(cash.count).toBe(2);
    expect(cash.amount).toBe(orderTotals[0] + orderTotals[1]);
    expect(wechat).toBeTruthy();
    expect(wechat.count).toBe(1);
    expect(wechat.amount).toBe(orderTotals[2]);
  });

  it('salesReport 按天分组应包含今日数据', async () => {
    const res = await adminClient.query(SALES_REPORT, {
      startDate: todayStr,
      endDate: todayStr,
    });
    const sr = res.salesReport;
    expect(sr).toBeTruthy();
    expect(sr.startDate).toBe(todayStr);
    expect(sr.endDate).toBe(todayStr);
    expect(sr.totalOrders).toBe(3);
    expect(sr.totalAmount).toBe(orderTotals.reduce((s, v) => s + v, 0));
    // daily 仅 1 天（今日）
    expect(sr.daily.length).toBe(1);
    expect(sr.daily[0].date).toBe(todayStr);
    expect(sr.daily[0].orderCount).toBe(3);
    expect(sr.daily[0].totalAmount).toBe(sr.totalAmount);
  });

  it('monthlyReport 应返回当月汇总', async () => {
    const res = await adminClient.query(MONTHLY_REPORT, {
      year: today.getFullYear(),
      month: today.getMonth() + 1,
    });
    const mr = res.monthlyReport;
    expect(mr).toBeTruthy();
    expect(mr.year).toBe(today.getFullYear());
    expect(mr.month).toBe(today.getMonth() + 1);
    expect(mr.orderCount).toBe(3);
    expect(mr.totalAmount).toBe(orderTotals.reduce((s, v) => s + v, 0));
    // 上月无数据，环比变化率应为 0
    expect(mr.prevMonth.totalAmount).toBe(0);
    expect(mr.prevMonth.orderCount).toBe(0);
    expect(mr.amountChangeRate).toBe(0);
  });

  it('topProducts 按销量排序应正确聚合 variant 数量', async () => {
    const res = await adminClient.query(TOP_PRODUCTS, {
      startDate: todayStr,
      endDate: todayStr,
      limit: 10,
      sortBy: 'quantity',
    });
    const tp = res.topProducts;
    expect(tp).toBeTruthy();
    expect(tp.items.length).toBeGreaterThanOrEqual(1);

    // variant1 销量 = 2 + 3 = 5，variant2 销量 = 1
    // 注意：variantId 和 variantId2 可能相同（products.csv 只有 1 variant 时）
    if (variantId !== variantId2) {
      // 第 1 名应为 variant1
      const top = tp.items[0];
      expect(top.variantId).toBe(variantId);
      expect(top.totalQuantity).toBe(5);
      // 第 2 名应为 variant2
      const second = tp.items[1];
      expect(second.variantId).toBe(variantId2);
      expect(second.totalQuantity).toBe(1);
    } else {
      // 同一 variant，销量 = 6
      expect(tp.items[0].totalQuantity).toBe(6);
    }

    // 验证按销量降序
    for (let i = 1; i < tp.items.length; i++) {
      expect(tp.items[i - 1].totalQuantity).toBeGreaterThanOrEqual(tp.items[i].totalQuantity);
    }
  });

  it('topProducts 按金额排序应返回金额最大的商品', async () => {
    const res = await adminClient.query(TOP_PRODUCTS, {
      startDate: todayStr,
      endDate: todayStr,
      limit: 5,
      sortBy: 'amount',
    });
    const tp = res.topProducts;
    expect(tp).toBeTruthy();
    expect(tp.items.length).toBeGreaterThanOrEqual(1);
    // 按金额降序
    for (let i = 1; i < tp.items.length; i++) {
      expect(tp.items[i - 1].totalAmount).toBeGreaterThanOrEqual(tp.items[i].totalAmount);
    }
  });

  it('topProducts 无数据日期范围应返回空列表', async () => {
    // 2000-01-01 不会有数据
    const res = await adminClient.query(TOP_PRODUCTS, {
      startDate: '2000-01-01',
      endDate: '2000-01-02',
      limit: 10,
      sortBy: 'quantity',
    });
    expect(res.topProducts.items).toEqual([]);
  });
});

