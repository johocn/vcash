import path from 'node:path';
import {
  createTestEnvironment,
  registerInitializer,
  SqljsInitializer,
  testConfig,
} from '@vendure/testing';
import {
  configureDefaultOrderProcess,
  DefaultLogger,
  LogLevel,
} from '@vendure/core';
import gql from 'graphql-tag';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { VcashPosPlugin } from '../src/plugin';
// 引用 member-level-plugin 编译产物（避免 @vendure/core 双实例加载冲突）
import { MemberLevelPlugin } from '../../../../vendure/packages/member-level-plugin/lib/index';

registerInitializer('sqljs', new SqljsInitializer('__data__'));

const posOrderProcess = configureDefaultOrderProcess({
  arrangingPaymentRequiresCustomer: false,
  arrangingPaymentRequiresShipping: false,
});

// ===== GraphQL Operations =====

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
      ... on Customer { id firstName lastName emailAddress phoneNumber }
    }
  }
`;

const ADJUST_GROWTH = gql`
  mutation AdjustGrowth($customerId: ID!, $amount: Int!, $source: String) {
    adjustMemberGrowth(customerId: $customerId, amount: $amount, source: $source) {
      customerId level levelName growthValue points
    }
  }
`;

const CREATE_MEMBER_PRICE_RULE = gql`
  mutation CreateMemberPriceRule($input: CreateMemberPriceRuleInput!) {
    createMemberPriceRule(input: $input) {
      id scope categoryId memberLevel discountPercent active priority
    }
  }
`;

const BIND_SESSION_MEMBER = gql`
  mutation BindSessionMember($customerId: ID!) {
    bindSessionMember(customerId: $customerId) {
      id code state customerId
    }
  }
`;

const UNBIND_SESSION_MEMBER = gql`
  mutation UnbindSessionMember {
    unbindSessionMember {
      id code state customerId
    }
  }
`;

const ADD_POS_ITEM = gql`
  mutation AddPosItem($productVariantId: ID!, $quantity: Int!) {
    addPosItem(input: { productVariantId: $productVariantId, quantity: $quantity }) {
      id
      state
      total
      lines {
        id
        quantity
        unitPrice
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
      lines {
        id
        quantity
        unitPrice
        productVariant { id name sku price }
        customFields { discount memberPriceApplied }
      }
    }
  }
`;

describe('会员价引擎', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [
      MemberLevelPlugin.init({
        defaultPointsEarnRatio: 1,
        defaultPointsEarnOnShipping: false,
      }),
      VcashPosPlugin,
    ],
  });

  let variantId: string;
  let unitPrice: number;
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

    const productsRes = await adminClient.query(GET_PRODUCTS);
    expect(productsRes.products.items.length).toBeGreaterThan(0);
    variantId = productsRes.products.items[0].variants[0].id;
    unitPrice = productsRes.products.items[0].variants[0].price;

    // 创建 StockLocation + Terminal + 开班
    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-MP-001',
      name: '会员价测试台',
      stockLocationId: sl.createStockLocation.id,
    });
    await adminClient.query(OPEN_SESSION, { terminalCode: 'POS-MP-001' });

    // 创建会员并升级到 LV2（阈值 1000）
    const c = await adminClient.query(CREATE_CUSTOMER, {
      input: {
        firstName: '会员',
        lastName: '测试',
        emailAddress: 'member-pricing@test.com',
        phoneNumber: '13800138001',
      },
    });
    customerId = c.createCustomer.id;
    await adminClient.query(ADJUST_GROWTH, {
      customerId,
      amount: 1500,
      source: 'test',
    });
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('未绑定会员时加购应原价（discount=100, memberPriceApplied=false）', async () => {
    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 1,
    });
    const line = res.addPosItem.lines[0];
    expect(line.customFields.discount).toBe(100);
    expect(line.customFields.memberPriceApplied).toBe(false);
    expect(line.unitPrice).toBe(unitPrice);
  });

  it('配置 LV2 全局 95 折规则', async () => {
    const res = await adminClient.query(CREATE_MEMBER_PRICE_RULE, {
      input: {
        scope: 'global',
        memberLevel: 2,
        discountPercent: 95,
      },
    });
    expect(res.createMemberPriceRule.discountPercent).toBe(95);
    expect(res.createMemberPriceRule.scope).toBe('global');
    expect(res.createMemberPriceRule.memberLevel).toBe(2);
  });

  it('绑定 LV2 会员后加购应自动应用 95 折', async () => {
    const bindRes = await adminClient.query(BIND_SESSION_MEMBER, { customerId });
    expect(bindRes.bindSessionMember.customerId).not.toBeNull();

    // 重新开班次新订单：先关单（已有一行原价商品）→ 不需要，直接 addPosItem 加新行
    // 注意：前一个测试已加 1 行原价商品，此处再加同一 variant 会合并行；
    // 为了独立验证，先重新开班（关 + 开），避免被合并影响。
    // 简化：直接加 variant，验证新行折扣生效（合并后数量+1，但 customFields 取合并后的）。
    // 但 Vendure addItemToOrder 合并行时会保留首行的 customFields，因此用不同 variant 验证更干净。
    const productsRes = await adminClient.query(GET_PRODUCTS);
    const anotherVariantId = productsRes.products.items[1].variants[0].id;
    const anotherUnitPrice = productsRes.products.items[1].variants[0].price;

    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: anotherVariantId,
      quantity: 1,
    });
    const lines = res.addPosItem.lines;
    const newLine = lines.find((l: any) => l.productVariant.id === anotherVariantId);
    expect(newLine).toBeTruthy();
    expect(newLine.customFields.discount).toBe(95);
    expect(newLine.customFields.memberPriceApplied).toBe(true);
    // unitPrice 应为原价 * 0.95（向下取整到分）
    const expected = Math.floor((anotherUnitPrice * 95) / 100);
    expect(newLine.unitPrice).toBe(expected);
  });

  it('解绑会员后加购应恢复原价', async () => {
    await adminClient.query(UNBIND_SESSION_MEMBER);
    const productsRes = await adminClient.query(GET_PRODUCTS);
    const anotherVariantId = productsRes.products.items[2].variants[0].id;

    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: anotherVariantId,
      quantity: 1,
    });
    const newLine = res.addPosItem.lines.find(
      (l: any) => l.productVariant.id === anotherVariantId,
    );
    expect(newLine).toBeTruthy();
    expect(newLine.customFields.discount).toBe(100);
    expect(newLine.customFields.memberPriceApplied).toBe(false);
  });
});
