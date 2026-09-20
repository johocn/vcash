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

// 与其他测试一致：配置 order process 确保 Order custom fields 列正确创建
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
      id code name active
    }
  }
`;

const OPEN_SESSION = gql`
  mutation OpenSession($terminalCode: String!, $openingFloat: Int) {
    openSession(input: { terminalCode: $terminalCode, openingFloat: $openingFloat }) {
      id
      code
      state
      openingFloat
      closingCash
      activeOrderId
      openedAt
      closedAt
      closeSummary
      operator { id firstName lastName emailAddress }
      approver { id }
      terminal { id code name }
      stockLocation { id name }
    }
  }
`;

const MY_POS_SESSION = gql`
  query MyPosSession {
    myPosSession {
      id
      code
      state
      operator { id firstName }
      terminal { id code }
    }
  }
`;

const CLOSE_SESSION = gql`
  mutation CloseSession($sessionId: ID!, $closingCash: Int) {
    closeSession(input: { sessionId: $sessionId, closingCash: $closingCash }) {
      session {
        id
        code
        state
        closingCash
        closedAt
        closeSummary
        activeOrderId
      }
      summary
    }
  }
`;

const POS_SESSION_BY_ID = gql`
  query PosSessionById($id: ID!) {
    posSession(id: $id) {
      id
      code
      state
      operator { id firstName }
      terminal { id code }
    }
  }
`;

describe('PosSession 开班/关班', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    orderOptions: { process: [posOrderProcess] },
    plugins: [VcashPosPlugin],
  });

  let terminalCode = 'POS-SESS-001';
  let sessionId: string;

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
      productsCsvPath: path.join(
        __dirname,
        '../../../server/__tests__/fixtures/products.csv',
      ),
    });
    await adminClient.asSuperAdmin();

    const sl = await adminClient.query(CREATE_STOCK_LOCATION, { name: '朝阳店' });
    const stockLocationId = sl.createStockLocation.id;
    await adminClient.query(CREATE_TERMINAL, {
      code: terminalCode,
      name: '1号收银台',
      stockLocationId,
    });
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应成功开班并返回 S 开头班次号', async () => {
    const result = await adminClient.query(OPEN_SESSION, {
      terminalCode,
      openingFloat: 50000, // 500 元（分）
    });
    const session = result.openSession;
    expect(session).toBeTruthy();
    expect(session.code).toMatch(/^S\d{8}-\d{3}$/);
    expect(session.state).toBe('open');
    expect(session.openingFloat).toBe(50000);
    expect(session.closingCash).toBe(0);
    expect(session.activeOrderId).toBeNull();
    expect(session.closedAt).toBeNull();
    expect(session.closeSummary).toBeNull();
    expect(session.operator).toBeTruthy();
    expect(session.operator.firstName).toBeTruthy();
    expect(session.terminal.code).toBe(terminalCode);
    expect(session.stockLocation.name).toBe('朝阳店');
    sessionId = session.id;
  });

  it('同终端重复开班应报错', async () => {
    await expect(
      adminClient.query(OPEN_SESSION, { terminalCode, openingFloat: 0 }),
    ).rejects.toThrow();
  });

  it('myPosSession 应返回当前开班班次', async () => {
    const result = await adminClient.query(MY_POS_SESSION);
    expect(result.myPosSession).toBeTruthy();
    expect(result.myPosSession.id).toBe(sessionId);
    expect(result.myPosSession.state).toBe('open');
    expect(result.myPosSession.terminal.code).toBe(terminalCode);
  });

  it('posSession(id) 应能查到该班次', async () => {
    const result = await adminClient.query(POS_SESSION_BY_ID, { id: sessionId });
    expect(result.posSession).toBeTruthy();
    expect(result.posSession.id).toBe(sessionId);
    expect(result.posSession.state).toBe('open');
  });

  it('应成功关班，state=closed，closeSummary 由 ShiftReportService 自动生成', async () => {
    const result = await adminClient.query(CLOSE_SESSION, {
      sessionId,
      closingCash: 48800,
    });
    expect(result.closeSession).toBeTruthy();
    expect(result.closeSession.session.state).toBe('closed');
    expect(result.closeSession.session.closingCash).toBe(48800);
    expect(result.closeSession.session.closedAt).toBeTruthy();
    // 未传 closeSummary，由 ShiftReportService 自动生成（本测试无订单，stats 全 0）
    expect(result.closeSession.session.closeSummary).not.toBeNull();
    expect(result.closeSession.summary).not.toBeNull();
    expect(result.closeSession.summary.orders.totalCount).toBe(0);
    expect(result.closeSession.summary.orders.normalCount).toBe(0);
    expect(result.closeSession.summary.paymentsByMethod).toEqual([]);
    // openingFloat=50000，closingCash=48800，无 cash payment → 应交 50000，短款 1200
    expect(result.closeSession.summary.warnings.length).toBeGreaterThan(0);
    // 关班后清空 activeOrderId
    expect(result.closeSession.session.activeOrderId).toBeNull();
  });

  it('关班后 myPosSession 应为 null', async () => {
    const result = await adminClient.query(MY_POS_SESSION);
    expect(result.myPosSession).toBeNull();
  });

  it('已关班的 session 再调 closeSession 应报错', async () => {
    await expect(
      adminClient.query(CLOSE_SESSION, { sessionId, closingCash: 0 }),
    ).rejects.toThrow();
  });
});
