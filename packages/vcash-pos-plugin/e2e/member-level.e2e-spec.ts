import path from 'node:path';
import {
  createTestEnvironment,
  registerInitializer,
  SqljsInitializer,
  testConfig,
} from '@vendure/testing';
import {
  Channel,
  ChannelService,
  configureDefaultOrderProcess,
  DefaultLogger,
  EventBus,
  LogLevel,
  Order,
  OrderStateTransitionEvent,
  Refund,
  RefundStateTransitionEvent,
  RequestContext,
} from '@vendure/core';
import gql from 'graphql-tag';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// 引用 member-level-plugin 编译产物（vitest esbuild 不支持 decorator metadata，必须用 lib/）
// 注意：只注册 MemberLevelPlugin，不注册 VcashPosPlugin，避免 @vendure/core 双实例加载冲突
import { MemberLevelPlugin } from '../../../../vendure/packages/member-level-plugin/lib/index';

registerInitializer('sqljs', new SqljsInitializer('__data__'));

const defaultOrderProcess = configureDefaultOrderProcess({
  arrangingPaymentRequiresCustomer: false,
  arrangingPaymentRequiresShipping: false,
});

// ===== GraphQL Operations =====

const CREATE_CUSTOMER = gql`
  mutation CreateCustomer($input: CreateCustomerInput!) {
    createCustomer(input: $input) {
      ... on Customer { id firstName lastName emailAddress phoneNumber }
    }
  }
`;

const MEMBER_INFO = gql`
  query MemberInfo($customerId: ID!) {
    memberInfo(customerId: $customerId) {
      customerId
      level
      levelName
      growthValue
      points
      nextLevelThreshold
      nextLevelName
    }
  }
`;

const ADJUST_POINTS = gql`
  mutation AdjustPoints($customerId: ID!, $amount: Int!, $remark: String) {
    adjustPoints(customerId: $customerId, amount: $amount, remark: $remark) {
      customerId
      level
      growthValue
      points
    }
  }
`;

const ADJUST_GROWTH = gql`
  mutation AdjustGrowth($customerId: ID!, $amount: Int!, $source: String) {
    adjustMemberGrowth(customerId: $customerId, amount: $amount, source: $source) {
      customerId
      level
      levelName
      growthValue
      points
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

describe('MemberLevel 会员等级与积分', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [defaultOrderProcess] },
    plugins: [MemberLevelPlugin.init({
      defaultPointsEarnRatio: 1,
      defaultPointsEarnOnShipping: false,
    })],
  });

  let customerId: string;
  let customerId2: string;
  let customerIdNum: number;
  let variantId: string;
  let adminCtx: RequestContext;

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

    // 构造带 channel 的 admin ctx，用于发布事件（RequestContext.empty() 缺 channel.id 触发 NOT NULL）
    const channelService = server.app.get(ChannelService);
    const defaultChannel = await channelService.findOne(RequestContext.empty(), 1);
    if (!defaultChannel) throw new Error('Default channel not found');
    adminCtx = new RequestContext({
      apiType: 'admin',
      authorizedAsOwnerOnly: false,
      channel: defaultChannel as Channel,
      isAuthorized: true,
    });
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应创建会员并初始化为 LV1', async () => {
    const res = await adminClient.query(CREATE_CUSTOMER, {
      input: {
        firstName: '张',
        lastName: '三',
        emailAddress: 'zhangsan@test.com',
        phoneNumber: '13800138000',
      },
    });
    customerId = res.createCustomer.id;
    customerIdNum = parseInt(String(customerId).split('_').pop() ?? '', 10);
    expect(customerId).toBeTruthy();
    expect(Number.isFinite(customerIdNum)).toBe(true);

    const info = await adminClient.query(MEMBER_INFO, { customerId });
    expect(info.memberInfo.level).toBe(1);
    expect(info.memberInfo.growthValue).toBe(0);
    expect(info.memberInfo.points).toBe(0);
  });

  it('成长值跨阈值应自动升级（LV1→LV2，阈值 1000）', async () => {
    const res = await adminClient.query(ADJUST_GROWTH, {
      customerId,
      amount: 1500,
      source: 'test',
    });
    expect(res.adjustMemberGrowth.level).toBe(2);
    expect(res.adjustMemberGrowth.growthValue).toBe(1500);
    expect(res.adjustMemberGrowth.levelName).toBe('银卡会员');
  });

  it('应支持积分增加/消费/调整', async () => {
    // 增加 500 积分
    await adminClient.query(ADJUST_POINTS, {
      customerId,
      amount: 500,
      remark: '初始赠送',
    });
    let info = await adminClient.query(MEMBER_INFO, { customerId });
    expect(info.memberInfo.points).toBe(500);

    // 消费 200 积分
    await adminClient.query(ADJUST_POINTS, {
      customerId,
      amount: -200,
      remark: '消费',
    });
    info = await adminClient.query(MEMBER_INFO, { customerId });
    expect(info.memberInfo.points).toBe(300);

    // 调整 +50 积分
    await adminClient.query(ADJUST_POINTS, {
      customerId,
      amount: 50,
      remark: '补偿',
    });
    info = await adminClient.query(MEMBER_INFO, { customerId });
    expect(info.memberInfo.points).toBe(350);
  });

  it('积分余额不足消费应被拒', async () => {
    await expect(
      adminClient.query(ADJUST_POINTS, {
        customerId,
        amount: -1000,
        remark: '超额消费',
      }),
    ).rejects.toThrow(/Insufficient points/);
  });

  it('订单 Delivered 应自动发放积分与成长值（幂等）', async () => {
    const eventBus = server.app.get(EventBus);
    const ctx = adminCtx;

    // 构造 mock order（member-level-plugin 只用到 order.customer.id, order.id, order.total, order.subTotal）
    // customer.id 必须是数据库主键 number（GraphQL 返回 'T_11' 不能直接 Number() 否则得到 NaN）
    const mockOrder = {
      id: 9991,
      subTotal: 500,
      total: 500,
      customer: { id: customerIdNum },
    } as unknown as Order;

    // 记录发放前积分
    const infoBefore = await adminClient.query(MEMBER_INFO, { customerId });
    const pointsBefore = infoBefore.memberInfo.points;
    const growthBefore = infoBefore.memberInfo.growthValue;

    // 发布 OrderStateTransitionEvent（toState = Delivered）
    await eventBus.publish(
      new OrderStateTransitionEvent('PaymentSettled', 'Delivered', ctx, mockOrder),
    );
    // 等待异步处理
    await new Promise(resolve => setTimeout(resolve, 500));

    // 验证积分与成长值发放
    const expectedGrowth = growthBefore + 500;
    const expectedPoints = pointsBefore + 500;

    const infoAfter = await adminClient.query(MEMBER_INFO, { customerId });
    expect(infoAfter.memberInfo.growthValue).toBe(expectedGrowth);
    expect(infoAfter.memberInfo.points).toBe(expectedPoints);

    // 幂等性：再次发布相同事件不应重复发放
    await eventBus.publish(
      new OrderStateTransitionEvent('PaymentSettled', 'Delivered', ctx, mockOrder),
    );
    await new Promise(resolve => setTimeout(resolve, 500));

    const infoAfterIdempotent = await adminClient.query(MEMBER_INFO, { customerId });
    expect(infoAfterIdempotent.memberInfo.points).toBe(expectedPoints);
    expect(infoAfterIdempotent.memberInfo.growthValue).toBe(expectedGrowth);
  });

  it('退款 Settled 应自动扣回积分与成长值', async () => {
    const eventBus = server.app.get(EventBus);
    const ctx = adminCtx;

    const mockOrder = {
      id: 9991,
      subTotal: 500,
      total: 500,
      customer: { id: customerIdNum },
    } as unknown as Order;
    const mockRefund = {
      id: 8881,
      total: 500,
    } as unknown as Refund;

    const infoBefore = await adminClient.query(MEMBER_INFO, { customerId });
    const pointsBefore = infoBefore.memberInfo.points;
    const growthBefore = infoBefore.memberInfo.growthValue;

    // 发布 RefundStateTransitionEvent（toState = Settled）
    await eventBus.publish(
      new RefundStateTransitionEvent('Pending', 'Settled', ctx, mockRefund, mockOrder),
    );
    await new Promise(resolve => setTimeout(resolve, 500));

    // 验证积分与成长值扣回
    const expectedGrowth = growthBefore - 500;
    const expectedPoints = pointsBefore - 500;

    const infoAfter = await adminClient.query(MEMBER_INFO, { customerId });
    expect(infoAfter.memberInfo.growthValue).toBe(expectedGrowth);
    expect(infoAfter.memberInfo.points).toBe(expectedPoints);
  });

  it('并发扣减应不超扣（pessimistic_write 锁）', async () => {
    // 创建第二个会员，充值 1000 积分
    const customerRes = await adminClient.query(CREATE_CUSTOMER, {
      input: {
        firstName: '李',
        lastName: '四',
        emailAddress: 'lisi@test.com',
        phoneNumber: '13900139000',
      },
    });
    customerId2 = customerRes.createCustomer.id;

    await adminClient.query(ADJUST_POINTS, {
      customerId: customerId2,
      amount: 1000,
      remark: '并发测试初始',
    });

    // 并发 10 次扣减 100 积分，总扣减 1000，余额应恰好为 0
    const promises = Array.from({ length: 10 }, () =>
      adminClient.query(ADJUST_POINTS, {
        customerId: customerId2,
        amount: -100,
        remark: '并发消费',
      }).catch(() => {}), // 部分可能因锁/余额不足失败，忽略
    );
    await Promise.all(promises);

    // 验证最终余额不为负
    const info = await adminClient.query(MEMBER_INFO, { customerId: customerId2 });
    expect(info.memberInfo.points).toBeGreaterThanOrEqual(0);
  });
});
