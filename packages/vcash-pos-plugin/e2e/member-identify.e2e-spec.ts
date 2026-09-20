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
      id code state customerId
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

const FIND_MEMBER_BY_PHONE = gql`
  query FindMemberByPhone($phoneNumber: String!) {
    findMemberByPhone(phoneNumber: $phoneNumber) {
      customerId firstName lastName emailAddress phoneNumber memberLevel growthValue points
    }
  }
`;

const FIND_MEMBER_BY_CODE = gql`
  query FindMemberByCode($code: String!) {
    findMemberByCode(code: $code) {
      customerId firstName lastName memberLevel points
    }
  }
`;

const BIND_SESSION_MEMBER = gql`
  mutation BindSessionMember($customerId: ID!) {
    bindSessionMember(customerId: $customerId) {
      id code state customerId
      customer { id firstName lastName }
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

const MY_POS_SESSION = gql`
  query MyPosSession {
    myPosSession {
      id code state customerId
      customer { id firstName lastName }
    }
  }
`;

describe('POS 会员识别 API', () => {
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

  let customerId: string;
  let customerIdNum: number;

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
      code: 'POS-MID-001',
      name: '会员识别测试台',
      stockLocationId: sl.createStockLocation.id,
    });
    await adminClient.query(OPEN_SESSION, { terminalCode: 'POS-MID-001' });

    const c = await adminClient.query(CREATE_CUSTOMER, {
      input: {
        firstName: '识别',
        lastName: '测试',
        emailAddress: 'identify@test.com',
        phoneNumber: '13800138002',
      },
    });
    customerId = c.createCustomer.id;
    customerIdNum = parseInt(String(customerId).split('_').pop() ?? '', 10);
    expect(Number.isFinite(customerIdNum)).toBe(true);
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('findMemberByPhone 应按手机号查到会员', async () => {
    const res = await adminClient.query(FIND_MEMBER_BY_PHONE, {
      phoneNumber: '13800138002',
    });
    expect(res.findMemberByPhone).toBeTruthy();
    expect(res.findMemberByPhone.customerId).toBe(customerId);
    expect(res.findMemberByPhone.firstName).toBe('识别');
    expect(res.findMemberByPhone.memberLevel).toBe(1);
    expect(res.findMemberByPhone.points).toBe(0);
  });

  it('findMemberByPhone 未匹配应返回 null', async () => {
    const res = await adminClient.query(FIND_MEMBER_BY_PHONE, {
      phoneNumber: '19999999999',
    });
    expect(res.findMemberByPhone).toBeNull();
  });

  it('findMemberByCode 应按卡号（customer.id）查到会员', async () => {
    const res = await adminClient.query(FIND_MEMBER_BY_CODE, {
      code: String(customerIdNum),
    });
    expect(res.findMemberByCode).toBeTruthy();
    expect(res.findMemberByCode.customerId).toBe(customerId);
  });

  it('findMemberByCode 非数字卡号应报错', async () => {
    await expect(
      adminClient.query(FIND_MEMBER_BY_CODE, { code: 'ABC' }),
    ).rejects.toThrow(/卡号格式无效/);
  });

  it('bindSessionMember 应将会员绑定到当前班次', async () => {
    const res = await adminClient.query(BIND_SESSION_MEMBER, { customerId });
    expect(res.bindSessionMember.customerId).toBe(customerIdNum);
    expect(res.bindSessionMember.customer).toBeTruthy();
    expect(res.bindSessionMember.customer.id).toBe(customerId);

    // myPosSession 应返回带 customerId 的班次
    const mySession = await adminClient.query(MY_POS_SESSION);
    expect(mySession.myPosSession.customerId).toBe(customerIdNum);
  });

  it('重复绑定应覆盖为最新会员（单会员模式）', async () => {
    // 创建第二个会员
    const c2 = await adminClient.query(CREATE_CUSTOMER, {
      input: {
        firstName: '第二位',
        lastName: '会员',
        emailAddress: 'second@test.com',
        phoneNumber: '13800138003',
      },
    });
    const customerId2 = c2.createCustomer.id;

    const res = await adminClient.query(BIND_SESSION_MEMBER, { customerId: customerId2 });
    expect(res.bindSessionMember.customer.id).toBe(customerId2);
    expect(res.bindSessionMember.customerId).not.toBe(customerIdNum);
  });

  it('unbindSessionMember 应解绑会员', async () => {
    const res = await adminClient.query(UNBIND_SESSION_MEMBER);
    expect(res.unbindSessionMember.customerId).toBeNull();

    const mySession = await adminClient.query(MY_POS_SESSION);
    expect(mySession.myPosSession.customerId).toBeNull();
  });
});
