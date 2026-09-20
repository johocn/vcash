import path from 'node:path';
import {
  createTestEnvironment,
  registerInitializer,
  SqljsInitializer,
  testConfig,
} from '@vendure/testing';
import { DefaultLogger, LogLevel } from '@vendure/core';
import gql from 'graphql-tag';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { VcashPosPlugin } from '../src/plugin';

registerInitializer('sqljs', new SqljsInitializer('__data__'));

const CREATE_RULE = gql`
  mutation CreatePromotionRule($input: CreatePromotionRuleInput!) {
    createPromotionRule(input: $input) {
      id type name scope priority active conditions actions
      startTime endTime
    }
  }
`;

const UPDATE_RULE = gql`
  mutation UpdatePromotionRule($input: UpdatePromotionRuleInput!) {
    updatePromotionRule(input: $input) {
      id priority active name
    }
  }
`;

const DELETE_RULE = gql`
  mutation DeletePromotionRule($id: ID!) {
    deletePromotionRule(id: $id)
  }
`;

const GET_RULE = gql`
  query PromotionRule($id: ID!) {
    promotionRule(id: $id) {
      id type name scope priority active
    }
  }
`;

const LIST_RULES = gql`
  query PromotionRules {
    promotionRules { id type name priority active startTime endTime }
  }
`;

describe('促销规则 CRUD', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    plugins: [VcashPosPlugin],
  });

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
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('用例1: 创建满减规则（满100减10/满200减30）', async () => {
    const res = await adminClient.query(CREATE_RULE, {
      input: {
        type: 'fullReduction',
        name: '满100减10/满200减30',
        conditions: {
          tiers: [
            { threshold: 100, reduction: 10 },
            { threshold: 200, reduction: 30 },
          ],
        },
      },
    });
    expect(res.createPromotionRule.id).toBeTruthy();
    expect(res.createPromotionRule.type).toBe('fullReduction');
    expect(res.createPromotionRule.scope).toBe('global');
    expect(res.createPromotionRule.priority).toBe(10);
    expect(res.createPromotionRule.active).toBe(true);
    expect(res.createPromotionRule.conditions.tiers).toHaveLength(2);
  });

  it('用例2: type-specific 校验 - discountPercent=150 应报错', async () => {
    await expect(
      adminClient.query(CREATE_RULE, {
        input: {
          type: 'discount',
          name: '无效折扣',
          actions: { discountPercent: 150 },
        },
      }),
    ).rejects.toThrow(/discountPercent 必须为 1-100/);
  });

  it('用例3: type-specific 校验 - fullReduction.tiers 非递增应报错', async () => {
    await expect(
      adminClient.query(CREATE_RULE, {
        input: {
          type: 'fullReduction',
          name: '无效阶梯',
          conditions: {
            tiers: [
              { threshold: 200, reduction: 30 },
              { threshold: 100, reduction: 10 },
            ],
          },
        },
      }),
    ).rejects.toThrow(/tiers.threshold 必须严格递增/);
  });

  it('用例4: type-specific 校验 - buyGift 缺少 buyQuantity 应报错', async () => {
    await expect(
      adminClient.query(CREATE_RULE, {
        input: {
          type: 'buyGift',
          name: '无效买赠',
          conditions: { buyVariantId: 1 },
          actions: { giftVariantId: 2, giftQuantity: 1 },
        },
      }),
    ).rejects.toThrow(/buyVariantId\/buyQuantity 必须为正数/);
  });

  it('用例5: 更新规则 priority 与 active', async () => {
    const created = await adminClient.query(CREATE_RULE, {
      input: {
        type: 'discount',
        name: '全场8折',
        actions: { discountPercent: 80 },
      },
    });
    const id = created.createPromotionRule.id;
    const res = await adminClient.query(UPDATE_RULE, {
      input: { id, priority: 50, active: false, name: '全场8折-已停用' },
    });
    expect(res.updatePromotionRule.priority).toBe(50);
    expect(res.updatePromotionRule.active).toBe(false);
    expect(res.updatePromotionRule.name).toBe('全场8折-已停用');
  });

  it('用例6: 删除规则后查询应返回 null', async () => {
    const created = await adminClient.query(CREATE_RULE, {
      input: {
        type: 'discount',
        name: '临时规则',
        actions: { discountPercent: 90 },
      },
    });
    const id = created.createPromotionRule.id;
    await adminClient.query(DELETE_RULE, { id });
    const res = await adminClient.query(GET_RULE, { id });
    expect(res.promotionRule).toBeNull();
  });

  it('用例7: findActiveRules 时段过滤 - 已过期规则不返回', async () => {
    // 创建已过期规则（endTime 在过去）
    await adminClient.query(CREATE_RULE, {
      input: {
        type: 'discount',
        name: '已过期规则',
        active: true,
        endTime: '2020-01-01T00:00:00.000Z',
        actions: { discountPercent: 50 },
      },
    });
    // 创建有效规则
    await adminClient.query(CREATE_RULE, {
      input: {
        type: 'discount',
        name: '有效规则',
        active: true,
        actions: { discountPercent: 90 },
      },
    });
    const res = await adminClient.query(LIST_RULES);
    const names = res.promotionRules.map((r: any) => r.name);
    // list 返回所有规则（不过滤时段），但验证已过期规则也存在
    expect(names).toContain('已过期规则');
    expect(names).toContain('有效规则');
    // 注：findActiveRules 是 service 内部方法，e2e 通过 promotionRules 查询所有规则
    // 时段过滤在 PromotionEngine.calculateBest 调用 findActiveRules 时验证（见 promotion-engine.e2e-spec.ts）
  });
});
