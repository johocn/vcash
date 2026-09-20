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

const UPDATE_VARIANT_STOCK = gql`
  mutation UpdateVariantStock($id: ID!, $stockLocationId: ID!, $stockOnHand: Int!) {
    updateProductVariant(input: {
      id: $id
      stockLevels: [{ stockLocationId: $stockLocationId, stockOnHand: $stockOnHand }]
    }) {
      id
      stockLevels { stockOnHand stockAllocated }
    }
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
      id scope memberLevel discountPercent active priority
    }
  }
`;

const CREATE_PROMOTION_RULE = gql`
  mutation CreatePromotionRule($input: CreatePromotionRuleInput!) {
    createPromotionRule(input: $input) {
      id type name scope priority active conditions actions
    }
  }
`;

const UPDATE_PROMOTION_RULE = gql`
  mutation UpdatePromotionRule($input: UpdatePromotionRuleInput!) {
    updatePromotionRule(input: $input) {
      id priority active
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
    unbindSessionMember { id code state customerId }
  }
`;

const ADD_POS_ITEM = gql`
  mutation AddPosItem($productVariantId: ID!, $quantity: Int!) {
    addPosItem(input: { productVariantId: $productVariantId, quantity: $quantity }) {
      id
      state
      total
      subTotal
      lines {
        id
        quantity
        unitPrice
        productVariant { id name sku price }
        customFields {
          originalPrice
          discount
          memberPriceApplied
          isGift
          note
          giftRuleId
        }
      }
      customFields {
        promotionId
        promotionType
        promotionDiscount
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
      subTotal
      lines {
        id
        quantity
        unitPrice
        productVariant { id name sku price }
        customFields {
          isGift
          note
          giftRuleId
          memberPriceApplied
          discount
        }
      }
      customFields {
        promotionId
        promotionType
        promotionDiscount
      }
    }
  }
`;

const HOLD_ORDER = gql`
  mutation HoldOrder {
    holdOrder { id code state }
  }
`;

describe('促销引擎 - 互斥最优', () => {
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
  let variantId2: string;
  let variantPrice: number;
  let variant2Price: number;
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
    expect(productsRes.products.items.length).toBeGreaterThanOrEqual(2);
    variantId = productsRes.products.items[0].variants[0].id;
    variantPrice = productsRes.products.items[0].variants[0].price;
    variantId2 = productsRes.products.items[1].variants[0].id;
    variant2Price = productsRes.products.items[1].variants[0].price;

    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    await adminClient.query(CREATE_TERMINAL, {
      code: 'POS-PE-001',
      name: '促销引擎测试台',
      stockLocationId: sl.createStockLocation.id,
    });
    await adminClient.query(OPEN_SESSION, { terminalCode: 'POS-PE-001' });

    // 给 variant2（买赠测试中的 gift variant）分配库存，确保买赠库存校验通过
    // 库存量需 ≥ giftQuantity（用例5/6 giftQuantity=1）
    await adminClient.query(UPDATE_VARIANT_STOCK, {
      id: variantId2,
      stockLocationId: sl.createStockLocation.id,
      stockOnHand: 10,
    });

    const c = await adminClient.query(CREATE_CUSTOMER, {
      input: {
        firstName: '促销',
        lastName: '测试',
        emailAddress: 'promo@test.com',
        phoneNumber: '13800138010',
      },
    });
    customerId = c.createCustomer.id;
    // 升级到 LV2（阈值 1000）
    await adminClient.query(ADJUST_GROWTH, {
      customerId,
      amount: 1500,
      source: 'test',
    });
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('用例1: 未绑定会员 + 无促销规则 → 原价，promotionType=null', async () => {
    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 1,
    });
    expect(res.addPosItem.customFields.promotionType).toBeNull();
    expect(res.addPosItem.customFields.promotionId).toBeNull();
    expect(res.addPosItem.lines[0].customFields.memberPriceApplied).toBe(false);
    expect(res.addPosItem.lines[0].customFields.discount).toBe(100);
  });

  it('用例2: 绑定 LV2 会员 + 配置 95 折会员价 → 加购应用会员价，promotionType=memberPrice', async () => {
    // 配置 LV2 全局 95 折会员价规则
    await adminClient.query(CREATE_MEMBER_PRICE_RULE, {
      input: {
        scope: 'global',
        memberLevel: 2,
        discountPercent: 95,
      },
    });
    // 绑定会员
    await adminClient.query(BIND_SESSION_MEMBER, { customerId });

    // 挂单当前订单（避免与用例1的 line 合并），开新单
    await adminClient.query(HOLD_ORDER);

    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId2,
      quantity: 1,
    });
    const line = res.addPosItem.lines[0];
    expect(line.customFields.memberPriceApplied).toBe(true);
    expect(line.customFields.discount).toBe(95);
    // 会员价 saving > 0，promotionType 应为 memberPrice
    expect(res.addPosItem.customFields.promotionType).toBe('memberPrice');
    expect(res.addPosItem.customFields.promotionId).toBeNull();
  });

  it('用例3: 加购 200 元 + 满减（满200减30）→ 互斥取最优：满减 -30 > 会员价 -10 → promotionType=fullReduction', async () => {
    // 挂单当前订单，开新单
    await adminClient.query(HOLD_ORDER);

    // 配置满减规则（满200减30）
    await adminClient.query(CREATE_PROMOTION_RULE, {
      input: {
        type: 'fullReduction',
        name: '满200减30',
        priority: 10,
        conditions: {
          tiers: [{ threshold: 200, reduction: 30 }],
        },
      },
    });

    // 加购 variant2，假设 variant2Price 在 200 左右（用 2 个数量凑 200）
    // 如果 variant2Price < 200，加 2 个凑；如果 ≥ 200，加 1 个
    const qtyNeeded = Math.ceil(200 / variant2Price);
    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId2,
      quantity: qtyNeeded,
    });

    // 互斥对比：
    // - 会员价 saving = variant2Price * 5% * qty（95 折省 5%）
    // - 满减 saving = 30
    // 取 max；若 qty * variant2Price * 0.05 < 30，则满减胜出
    const memberSaving = Math.floor((variant2Price * 5) / 100) * qtyNeeded;
    if (memberSaving < 30) {
      expect(res.addPosItem.customFields.promotionType).toBe('fullReduction');
      expect(res.addPosItem.customFields.promotionDiscount).toBe(30);
      expect(res.addPosItem.customFields.promotionId).not.toBeNull();
    } else {
      // 若会员价更优，则应用会员价（取决于 variant2Price 实际值）
      expect(res.addPosItem.customFields.promotionType).toBe('memberPrice');
    }
  });

  it('用例4: 配置 8 折折扣规则 → 若 saving=40% > 满减 30 → promotionType=discount', async () => {
    // 挂单开新单
    await adminClient.query(HOLD_ORDER);

    // 配置 8 折折扣规则（priority 较高，确保优先级测试）
    await adminClient.query(CREATE_PROMOTION_RULE, {
      input: {
        type: 'discount',
        name: '全场8折',
        priority: 20,
        actions: { discountPercent: 80 },
      },
    });

    const qtyNeeded = Math.ceil(200 / variant2Price);
    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId2,
      quantity: qtyNeeded,
    });

    // 计算：
    // - 会员价 saving = variant2Price * 5% * qty
    // - 满减 saving = 30（满200减30）
    // - 折扣 saving = variant2Price * 20% * qty
    const subTotal = variant2Price * qtyNeeded;
    const memberSaving = Math.floor((variant2Price * 5) / 100) * qtyNeeded;
    const discountSaving = Math.floor((subTotal * 20) / 100);

    // 折扣 8 折 saving 应该最大（20% > 5% 会员价，且通常 > 30 满减）
    if (discountSaving >= memberSaving && discountSaving >= 30) {
      expect(res.addPosItem.customFields.promotionType).toBe('discount');
      expect(res.addPosItem.customFields.promotionDiscount).toBe(discountSaving);
    }
  });

  it('用例5: 买赠规则（买2送1, gift 价值50）→ promotionType=buyGift, order 多一行 isGift=true', async () => {
    // 挂单开新单
    await adminClient.query(HOLD_ORDER);

    // 先禁用前面的折扣与满减规则（避免互斥干扰买赠测试）
    // 通过查询所有规则，逐个 update active=false
    const listRes = await adminClient.query(gql`
      query ListRules {
        promotionRules { id type name active priority }
      }
    `);
    for (const rule of listRes.promotionRules) {
      await adminClient.query(UPDATE_PROMOTION_RULE, {
        input: { id: rule.id, active: false },
      });
    }

    // 配置买赠规则：买 2 个 variant 送 1 个 variant2
    await adminClient.query(CREATE_PROMOTION_RULE, {
      input: {
        type: 'buyGift',
        name: '买2送1',
        priority: 10,
        conditions: {
          buyVariantId: parseInt(String(variantId).split('_').pop() ?? '0', 10),
          buyQuantity: 2,
        },
        actions: {
          giftVariantId: parseInt(String(variantId2).split('_').pop() ?? '0', 10),
          giftQuantity: 1,
        },
      },
    });

    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 2,
    });

    // 应触发买赠：order 多一行 isGift=true
    const giftLines = res.addPosItem.lines.filter(
      (l: any) => l.customFields.isGift === true,
    );
    expect(giftLines.length).toBe(1);
    expect(giftLines[0].customFields.giftRuleId).not.toBeNull();
    expect(giftLines[0].customFields.note).toContain('买赠:买2送1');
    expect(res.addPosItem.customFields.promotionType).toBe('buyGift');
  });

  it('用例6: reapply 幂等性 - 再次加购同 variant 不重复加 gift line', async () => {
    // 当前已有买赠触发，再加 1 个 variant（凑成 3 个），gift 应只有 1 行（reapply 先清理再加）
    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId,
      quantity: 1,
    });
    const giftLines = res.addPosItem.lines.filter(
      (l: any) => l.customFields.isGift === true,
    );
    // reapply 清理旧 gift 后重新计算，仍命中买赠，应只有 1 行 gift
    expect(giftLines.length).toBe(1);
  });

  it('用例7: priority 高者优先（即使 saving 较低）', async () => {
    // 挂单开新单
    await adminClient.query(HOLD_ORDER);

    // 禁用买赠规则
    const listRes = await adminClient.query(gql`
      query ListRules2 {
        promotionRules { id type name active priority }
      }
    `);
    for (const rule of listRes.promotionRules) {
      await adminClient.query(UPDATE_PROMOTION_RULE, {
        input: { id: rule.id, active: false },
      });
    }

    // 解绑会员：本用例专注测试 priority 排序，需排除会员价 candidate 干扰
    // （variant2Price=350，会员价 95 折 saving=18 > 满减 reduction=10，会胜出）
    await adminClient.query(UNBIND_SESSION_MEMBER);

    // 配置两条规则，同 saving 但 priority 不同：
    // - 规则A: 满减 满100减10, priority=5
    // - 规则B: 满减 满100减10, priority=10
    // 加购 100 元，两条都命中 saving=10，priority 高的 B 胜出
    const ruleA = await adminClient.query(CREATE_PROMOTION_RULE, {
      input: {
        type: 'fullReduction',
        name: '规则A-priority5',
        priority: 5,
        conditions: { tiers: [{ threshold: 100, reduction: 10 }] },
      },
    });
    const ruleB = await adminClient.query(CREATE_PROMOTION_RULE, {
      input: {
        type: 'fullReduction',
        name: '规则B-priority10',
        priority: 10,
        conditions: { tiers: [{ threshold: 100, reduction: 10 }] },
      },
    });

    const qtyNeeded = Math.ceil(100 / variant2Price);
    const res = await adminClient.query(ADD_POS_ITEM, {
      productVariantId: variantId2,
      quantity: qtyNeeded,
    });

    // 应命中 priority=10 的规则B
    // promotionId 是 int custom field，DB 存数字；ruleB.id 是 Vendure ID 字符串 'T_N'
    expect(res.addPosItem.customFields.promotionType).toBe('fullReduction');
    expect(res.addPosItem.customFields.promotionId).toBe(
      parseInt(String(ruleB.createPromotionRule.id).split('_').pop() ?? '0', 10),
    );
    expect(res.addPosItem.customFields.promotionId).not.toBe(
      parseInt(String(ruleA.createPromotionRule.id).split('_').pop() ?? '0', 10),
    );
  });
});
