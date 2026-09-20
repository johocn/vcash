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

/**
 * 验证 Order/OrderLine/Payment custom fields 已被 Vendure 注入到 GraphQL schema。
 * 这里通过 __type 内省查询确认字段存在，无需真正下单。
 */
const ORDER_CUSTOM_FIELDS_TYPE = gql`
  query OrderCustomFieldsType {
    __type(name: "OrderCustomFields") {
      name
      fields {
        name
        type { name kind }
      }
    }
  }
`;

const ORDER_LINE_CUSTOM_FIELDS_TYPE = gql`
  query OrderLineCustomFieldsType {
    __type(name: "OrderLineCustomFields") {
      name
      fields {
        name
        type { name kind }
      }
    }
  }
`;

const PAYMENT_CUSTOM_FIELDS_TYPE = gql`
  query PaymentCustomFieldsType {
    __type(name: "PaymentCustomFields") {
      name
      fields {
        name
        type { name kind }
      }
    }
  }
`;

describe('Custom fields 注册校验', () => {
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

  it('Order custom fields 应包含 posSessionId / orderType / refundedOrderId / shiftId / terminalCode / aggregatePayStatus / promotionId / promotionType / promotionDiscount', async () => {
    const result = await adminClient.query(ORDER_CUSTOM_FIELDS_TYPE);
    const fields: Array<{ name: string }> = result.__type?.fields ?? [];
    const names = fields.map((f) => f.name);
    expect(names).toContain('posSessionId');
    expect(names).toContain('orderType');
    expect(names).toContain('refundedOrderId');
    expect(names).toContain('shiftId');
    expect(names).toContain('terminalCode');
    expect(names).toContain('aggregatePayStatus');
    expect(names).toContain('promotionId');
    expect(names).toContain('promotionType');
    expect(names).toContain('promotionDiscount');
  });

  it('OrderLine custom fields 应包含 originalPrice / discount / memberPriceApplied / isGift / note / giftRuleId', async () => {
    const result = await adminClient.query(ORDER_LINE_CUSTOM_FIELDS_TYPE);
    const fields: Array<{ name: string }> = result.__type?.fields ?? [];
    const names = fields.map((f) => f.name);
    expect(names).toContain('originalPrice');
    expect(names).toContain('discount');
    expect(names).toContain('memberPriceApplied');
    expect(names).toContain('isGift');
    expect(names).toContain('note');
    expect(names).toContain('giftRuleId');
  });

  it('Payment custom fields 应包含 aggregatePayCode / aggregatePayStatus / needsManualRefund / posSessionId', async () => {
    const result = await adminClient.query(PAYMENT_CUSTOM_FIELDS_TYPE);
    const fields: Array<{ name: string }> = result.__type?.fields ?? [];
    const names = fields.map((f) => f.name);
    expect(names).toContain('aggregatePayCode');
    expect(names).toContain('aggregatePayStatus');
    expect(names).toContain('needsManualRefund');
    expect(names).toContain('posSessionId');
  });
});
