import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestEnvironment,
  registerInitializer,
  SqljsInitializer,
  testConfig,
} from '@vendure/testing';
import { DefaultLogger, LogLevel } from '@vendure/core';
import gql from 'graphql-tag';
import path from 'node:path';
import { config } from '../vendure-config';

registerInitializer('sqljs', new SqljsInitializer('__data__'));

const CREATE_CHANNEL = gql`
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) {
      __typename
      ... on Channel { id code token }
      ... on LanguageNotAvailableError { errorCode message }
    }
  }
`;

const CREATE_STOCK_LOCATION = gql`
  mutation CreateStockLocation($input: CreateStockLocationInput!) {
    createStockLocation(input: $input) { id name description }
  }
`;

const GET_ZONES = gql`query { zones { items { id name } } }`;
const GET_CHANNELS = gql`query { channels { items { id code } } }`;
const GET_STOCK_LOCATIONS = gql`query { stockLocations { items { id name } } }`;
const GET_PRODUCTS = gql`query { products { items { id name variants { sku } } } }`;
const GET_ROLES = gql`query { roles { items { id code } } }`;

describe('多租户多仓库基础能力', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    plugins: config.plugins,
  });

  let defaultZoneId: string;

  beforeAll(async () => {
    await server.init({
      initialData: {
        defaultLanguage: 'en',
        defaultZone: 'Asia',
        roles: [
          { code: 'cashier', description: '收银员', permissions: ['Authenticated'] },
          { code: 'shift-manager', description: '班次经理', permissions: ['Authenticated'] },
        ],
        countries: [{ code: 'CN', name: '中国', zone: 'Asia' }],
        taxRates: [{ name: 'standard', percentage: 0 }],
        shippingMethods: [],
        paymentMethods: [],
        collections: [],
      },
      productsCsvPath: path.join(__dirname, 'fixtures/products.csv'),
    });
    await adminClient.asSuperAdmin();
    const { zones } = await adminClient.query(GET_ZONES);
    defaultZoneId = zones.items[0].id;
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应创建第二个 Channel（海淀连锁）', async () => {
    const result = await adminClient.query(CREATE_CHANNEL, {
      input: {
        code: 'haidian-chain',
        token: 'haidian-chain',
        defaultCurrencyCode: 'CNY',
        defaultLanguageCode: 'en',
        pricesIncludeTax: false,
        defaultTaxZoneId: defaultZoneId,
        defaultShippingZoneId: defaultZoneId,
      },
    });
    expect(result.createChannel.__typename).toBe('Channel');
    expect(result.createChannel.code).toBe('haidian-chain');
  });

  it('应创建 3 个 StockLocation', async () => {
    const locations = [
      { name: '朝阳店-总店' },
      { name: '朝阳店-分店' },
      { name: '海淀店-总店' },
    ];
    for (const loc of locations) {
      const result = await adminClient.query(CREATE_STOCK_LOCATION, {
        input: { name: loc.name },
      });
      expect(result.createStockLocation.name).toBe(loc.name);
    }
  });

  it('应查询到 2 个 Channel', async () => {
    const { channels } = await adminClient.query(GET_CHANNELS);
    expect(channels.items.length).toBe(2);
  });

  it('应查询到 3 个新建 StockLocation（含 Vendure 默认仓库共 4 个）', async () => {
    const { stockLocations } = await adminClient.query(GET_STOCK_LOCATIONS);
    // Vendure 初始化时会自动创建 1 个 "Default Stock Location"
    const names = stockLocations.items.map((s: any) => s.name);
    expect(names).toContain('朝阳店-总店');
    expect(names).toContain('朝阳店-分店');
    expect(names).toContain('海淀店-总店');
  });

  it('商品应可查询（populate 成功）', async () => {
    const { products } = await adminClient.query(GET_PRODUCTS);
    expect(products.items.length).toBeGreaterThanOrEqual(3);
    const skus = products.items.flatMap((p: any) => p.variants.map((v: any) => v.sku));
    expect(skus).toContain('COKE-330');
    expect(skus).toContain('SPRITE-500');
    expect(skus).toContain('APPLE-001');
  });

  it('cashier 与 shift-manager 角色应存在', async () => {
    const { roles } = await adminClient.query(GET_ROLES);
    const codes = roles.items.map((r: any) => r.code);
    expect(codes).toContain('cashier');
    expect(codes).toContain('shift-manager');
  });
});
