# vcash Phase 2: vcash-pos-plugin 核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 实现 vcash-pos-plugin 核心插件：PosTerminal/PosSession/ProductVariantMemberPrice 实体 + Order/OrderLine custom fields + Admin GraphQL API + 在线收银流程（开班/加商品/结账/关班）+ 聚合码支付 + 退货 + 交班对账单。

**Architecture:** Vendure 3.6.4 插件，实体用 TypeORM 装饰器，custom fields 用 Vendure CustomField 扩展，GraphQL 用 Admin API 扩展，服务层注入 Vendure OrderService/StockLevelService。收银员用 Administrator 账号走 Admin API。

**Tech Stack:** Vendure 3.6.4, TypeORM, TypeScript 5, Vitest, @vendure/testing

**Spec 参考:** `docs/superpowers/specs/2026-08-01-vcash-redesign-design.md` §3 数据模型、§4 GraphQL API、§3.10 退货退款

**Phase 1 成果:** pnpm workspace + server 包 + Vendure 配置（cjk/member-level 插件已注册）+ 6 测试通过

---

## File Structure

```
packages/vcash-pos-plugin/
├── src/
│   ├── entities/
│   │   ├── pos-terminal.entity.ts          # PosTerminal 实体
│   │   ├── pos-session.entity.ts           # PosSession 实体
│   │   └── product-variant-member-price.entity.ts  # 商品级会员价
│   ├── custom-fields/
│   │   ├── order-custom-fields.ts          # Order custom fields
│   │   ├── order-line-custom-fields.ts     # OrderLine custom fields
│   │   └── payment-custom-fields.ts        # Payment custom fields（聚合码）
│   ├── services/
│   │   ├── pos-terminal.service.ts         # 终端 CRUD
│   │   ├── pos-session.service.ts          # 班次生命周期
│   │   ├── pos-order.service.ts            # 加商品/结账
│   │   ├── aggregate-pay.service.ts        # 聚合码支付状态机
│   │   ├── shift-report.service.ts         # 交班对账单
│   │   └── refund.service.ts               # 退货退款
│   ├── resolvers/
│   │   ├── admin-terminal.resolver.ts      # PosTerminal CRUD API
│   │   ├── admin-pos.resolver.ts           # POS 收银操作 API
│   │   └── admin-refund.resolver.ts        # 退货 API
│   ├── types.ts                            # 共享类型
│   ├── constants.ts                        # 权限标识、状态枚举
│   └── plugin.ts                           # 插件入口
├── e2e/
│   ├── terminal-session.e2e-spec.ts        # 终端+班次测试
│   ├── pos-flow.e2e-spec.ts                # 完整收银流程
│   ├── aggregate-pay.e2e-spec.ts           # 聚合码支付
│   ├── refund.e2e-spec.ts                  # 退货
│   └── shift-report.e2e-spec.ts            # 交班对账
├── package.json
└── tsconfig.json
```

---

## Task 1: 插件包脚手架 + 注册到 server

**Files:**
- Create: `packages/vcash-pos-plugin/package.json`
- Create: `packages/vcash-pos-plugin/tsconfig.json`
- Create: `packages/vcash-pos-plugin/src/plugin.ts`
- Create: `packages/vcash-pos-plugin/src/constants.ts`
- Create: `packages/vcash-pos-plugin/src/types.ts`
- Modify: `server/package.json`（添加依赖）
- Modify: `server/vendure-config.ts`（注册插件）

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@vcash/pos-plugin",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@vendure/core": "3.6.4"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "@vendure/testing": "3.6.4",
    "vitest": "^1.6.0"
  },
  "peerDependencies": {
    "@vendure/core": "3.6.4"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "e2e"]
}
```

- [ ] **Step 3: 创建 src/constants.ts**

```typescript
export const POS_PERMISSIONS = {
  TERMINAL_READ: 'PosTerminal.Read',
  TERMINAL_CREATE: 'PosTerminal.Create',
  TERMINAL_UPDATE: 'PosTerminal.Update',
  TERMINAL_DELETE: 'PosTerminal.Delete',
  SESSION_READ: 'PosSession.Read',
  SESSION_OPEN: 'PosSession.Open',
  SESSION_CLOSE: 'PosSession.Close',
  SESSION_APPROVE: 'PosSession.Approve',
  ORDER_ADD_ITEM: 'PosOrder.AddItem',
  ORDER_CHECKOUT: 'PosOrder.Checkout',
  ORDER_REFUND: 'Order.Refund.Create',
  PRODUCT_READ: 'PosProduct.Read',
  MEMBER_READ: 'PosMember.Read',
  ORDER_SYNC: 'PosOrder.Sync',
} as const;

export const POS_SESSION_STATE = {
  OPEN: 'open',
  CLOSED: 'closed',
} as const;

export const ORDER_TYPE = {
  SALE: 'sale',
  REFUND: 'refund',
  HOLD: 'hold',
} as const;

export const AGGREGATE_PAY_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  SETTLED: 'settled',
  FAILED: 'failed',
  REFUNDED: 'refunded',
} as const;
```

- [ ] **Step 4: 创建 src/types.ts**

```typescript
export interface ShiftSummary {
  orders: {
    totalCount: number;
    totalAmount: number;
    normalCount: number;
    refundCount: number;
    refundAmount: number;
    heldCount: number;
  };
  paymentsByMethod: Array<{ method: string; count: number; amount: number }>;
  warnings: string[];
}

export interface ReceiptData {
  header: string;
  phone: string;
  address: string;
  footer: string;
  orderCode: string;
  createdAt: string;
  cashier: string;
  lines: Array<{
    name: string;
    qty: number;
    priceUnit: number;
    subtotal: number;
    discount: number;
  }>;
  total: number;
  payments: Array<{ method: string; amount: number }>;
  change: number | null;
}
```

- [ ] **Step 5: 创建 src/plugin.ts（空骨架）**

```typescript
import { VendurePlugin } from '@vendure/core';

@VendurePlugin({
  configuration: (config) => {
    return config;
  },
})
export class VcashPosPlugin {}
```

- [ ] **Step 6: 在 server/package.json 添加依赖**

在 dependencies 中添加：
```json
    "@vcash/pos-plugin": "file:../packages/vcash-pos-plugin",
```

- [ ] **Step 7: 修改 server/vendure-config.ts 注册插件**

import 并在 plugins 数组中添加 `VcashPosPlugin`（放在 MemberLevelPlugin 之后）。

- [ ] **Step 8: 安装依赖并验证编译**

```bash
cd e:\code\vcash
pnpm install
pnpm --filter @vcash/pos-plugin build
pnpm --filter @vcash/server build
```

- [ ] **Step 9: 运行现有测试确认无回归**

```bash
pnpm --filter @vcash/server test
```
Expected: 6 测试仍通过。

- [ ] **Step 10: Commit**

```bash
git -C e:\code add vcash/packages/vcash-pos-plugin/ vcash/server/package.json vcash/server/vendure-config.ts vcash/pnpm-lock.yaml
git -C e:\code commit -m "feat(pos-plugin): 创建插件包脚手架并注册到 server"
```

---

## Task 2: PosTerminal 实体 + CRUD 服务 + GraphQL

**Files:**
- Create: `packages/vcash-pos-plugin/src/entities/pos-terminal.entity.ts`
- Create: `packages/vcash-pos-plugin/src/services/pos-terminal.service.ts`
- Create: `packages/vcash-pos-plugin/src/resolvers/admin-terminal.resolver.ts`
- Modify: `packages/vcash-pos-plugin/src/plugin.ts`
- Create: `packages/vcash-pos-plugin/e2e/terminal-session.e2e-spec.ts`

- [ ] **Step 1: 创建 PosTerminal 实体**

```typescript
// src/entities/pos-terminal.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { Channel, StockLocation } from '@vendure/core';

@Entity()
export class PosTerminal {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() name: string;
  @ManyToOne(() => Channel)
  @Index()
  channel: Channel;
  @ManyToOne(() => StockLocation)
  stockLocation: StockLocation;
  @Column({ default: true }) active: boolean;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
  @Column({ type: 'json', nullable: true })
  deviceConfig: {
    printerVendorId?: string;
    printerProductId?: string;
    scaleBaudRate?: number;
    scaleProtocol?: 'continuous' | 'polling';
    cashDrawerViaPrinter?: boolean;
    paperWidth?: 58 | 80;
  } | null;
}
```

- [ ] **Step 2: 创建 PosTerminalService**

```typescript
// src/services/pos-terminal.service.ts
import { Injectable, UserInputError } from '@vendure/core';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import { PosTerminal } from '../entities/pos-terminal.entity';

@Injectable()
export class PosTerminalService {
  constructor(@InjectConnection() private connection: Connection) {}

  async findAll(channelId?: number): Promise<PosTerminal[]> {
    const qb = this.connection.getRepository(PosTerminal).createQueryBuilder('terminal')
      .leftJoinAndSelect('terminal.channel', 'channel')
      .leftJoinAndSelect('terminal.stockLocation', 'stockLocation');
    if (channelId) {
      qb.where('channel.id = :channelId', { channelId });
    }
    return qb.getMany();
  }

  async findOne(id: number): Promise<PosTerminal | undefined> {
    return this.connection.getRepository(PosTerminal).findOne({
      where: { id },
      relations: ['channel', 'stockLocation'],
    });
  }

  async findByCode(code: string): Promise<PosTerminal | undefined> {
    return this.connection.getRepository(PosTerminal).findOne({
      where: { code },
      relations: ['channel', 'stockLocation'],
    });
  }

  async create(input: {
    code: string;
    name: string;
    channelId: string;
    stockLocationId: string;
    deviceConfig?: any;
  }): Promise<PosTerminal> {
    const existing = await this.findByCode(input.code);
    if (existing) {
      throw new UserInputError(`终端编号 ${input.code} 已存在`);
    }
    const terminal = new PosTerminal();
    terminal.code = input.code;
    terminal.name = input.name;
    terminal.channel = { id: parseInt(input.channelId) } as any;
    terminal.stockLocation = { id: parseInt(input.stockLocationId) } as any;
    terminal.deviceConfig = input.deviceConfig ?? null;
    return this.connection.getRepository(PosTerminal).save(terminal);
  }

  async update(id: number, input: Partial<{
    name: string;
    stockLocationId: string;
    active: boolean;
    deviceConfig: any;
  }>): Promise<PosTerminal> {
    const terminal = await this.findOne(id);
    if (!terminal) throw new UserInputError(`终端 ${id} 不存在`);
    if (input.name !== undefined) terminal.name = input.name;
    if (input.stockLocationId !== undefined) {
      terminal.stockLocation = { id: parseInt(input.stockLocationId) } as any;
    }
    if (input.active !== undefined) terminal.active = input.active;
    if (input.deviceConfig !== undefined) terminal.deviceConfig = input.deviceConfig;
    return this.connection.getRepository(PosTerminal).save(terminal);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.connection.getRepository(PosTerminal).delete(id);
    return result.affected > 0;
  }
}
```

- [ ] **Step 3: 创建 admin-terminal.resolver.ts**

```typescript
// src/resolvers/admin-terminal.resolver.ts
import { Resolver, Query, Mutation, Args, Context } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext, UserInputError } from '@vendure/core';
import { PosTerminalService } from '../services/pos-terminal.service';
import { PosTerminal } from '../entities/pos-terminal.entity';
import { POS_PERMISSIONS } from '../constants';

@Resolver()
export class AdminTerminalResolver {
  constructor(private terminalService: PosTerminalService) {}

  @Query()
  @Allow(Permission.ReadSettings, POS_PERMISSIONS.TERMINAL_READ)
  async posTerminals(@Ctx() ctx: RequestContext, @Args('channelId') channelId?: string): Promise<PosTerminal[]> {
    return this.terminalService.findAll(channelId ? parseInt(channelId) : ctx.channelId);
  }

  @Query()
  @Allow(Permission.ReadSettings, POS_PERMISSIONS.TERMINAL_READ)
  async posTerminal(@Args('id') id: string): Promise<PosTerminal | undefined> {
    return this.terminalService.findOne(parseInt(id));
  }

  @Mutation()
  @Allow(Permission.CreateSettings, POS_PERMISSIONS.TERMINAL_CREATE)
  async createPosTerminal(@Args('input') input: any, @Ctx() ctx: RequestContext): Promise<PosTerminal> {
    return this.terminalService.create({ ...input, channelId: String(ctx.channelId) });
  }

  @Mutation()
  @Allow(Permission.UpdateSettings, POS_PERMISSIONS.TERMINAL_UPDATE)
  async updatePosTerminal(@Args('input') input: any): Promise<PosTerminal> {
    return this.terminalService.update(parseInt(input.id), input);
  }

  @Mutation()
  @Allow(Permission.DeleteSettings, POS_PERMISSIONS.TERMINAL_DELETE)
  async deletePosTerminal(@Args('id') id: string): Promise<boolean> {
    const ok = await this.terminalService.delete(parseInt(id));
    if (!ok) throw new UserInputError(`终端 ${id} 不存在`);
    return true;
  }
}
```

- [ ] **Step 4: 更新 plugin.ts 注册实体/服务/resolver**

```typescript
import { VendurePlugin, PluginCommonModule } from '@vendure/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PosTerminal } from './entities/pos-terminal.entity';
import { PosTerminalService } from './services/pos-terminal.service';
import { AdminTerminalResolver } from './resolvers/admin-terminal.resolver';

@VendurePlugin({
  imports: [PluginCommonModule, TypeOrmModule.forFeature([PosTerminal])],
  entities: [PosTerminal],
  providers: [PosTerminalService],
  adminApiExtensions: {
    resolvers: [AdminTerminalResolver],
  },
  configuration: (config) => {
    return config;
  },
})
export class VcashPosPlugin {}
```

- [ ] **Step 5: 编写 e2e 测试**

创建 `e2e/terminal-session.e2e-spec.ts`（先只测 PosTerminal CRUD）：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { DefaultLogger, LogLevel } from '@vendure/core';
import path from 'node:path';
import { config } from '../../server/vendure-config';
import { VcashPosPlugin } from '../src/plugin';

registerInitializer('sqljs', new SqljsInitializer('__data__'));

describe('PosTerminal CRUD', () => {
  const { server, adminClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    plugins: [...config.plugins, VcashPosPlugin],
  });

  beforeAll(async () => {
    await server.init({
      initialData: {
        defaultChannel: true,
        defaultLanguage: 'zh',
        // ... 复用 Phase 1 的 initialData
        collections: [{ name: '默认', filters: [] }],
        countries: [{ code: 'CN', name: '中国', zone: 'standard' }],
        taxRates: [{ name: '标准', percentage: 0, enabled: true, zone: 'standard' }],
        shippingMethods: [],
        paymentMethods: [],
      },
      productsCsvPath: path.join(__dirname, '../../server/__tests__/fixtures/products.csv'),
    });
    await adminClient.asSuperAdmin();
  }, 180000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应创建 StockLocation', async () => {
    const result = await adminClient.query(`
      mutation { createStockLocation(input: { name: "朝阳店", code: "CY-001" }) { id name code } }
    `);
    expect(result.createStockLocation.code).toBe('CY-001');
  });

  it('应创建 PosTerminal', async () => {
    const stockLoc = await adminClient.query(`query { stockLocations { items { id } } }`);
    const stockLocationId = stockLoc.stockLocations.items[0].id;
    
    const result = await adminClient.query(`
      mutation CreateTerminal {
        createPosTerminal(input: {
          code: "POS-001"
          name: "1号收银台"
          stockLocationId: "${stockLocationId}"
        }) {
          id
          code
          name
          active
        }
      }
    `);
    expect(result.createPosTerminal.code).toBe('POS-001');
    expect(result.createPosTerminal.name).toBe('1号收银台');
    expect(result.createPosTerminal.active).toBe(true);
  });

  it('应查询 PosTerminal', async () => {
    const result = await adminClient.query(`query { posTerminals { id code name } }`);
    expect(result.posTerminals.length).toBe(1);
    expect(result.posTerminals[0].code).toBe('POS-001');
  });

  it('应更新 PosTerminal', async () => {
    const terminals = await adminClient.query(`query { posTerminals { id } }`);
    const id = terminals.posTerminals[0].id;
    
    const result = await adminClient.query(`
      mutation { updatePosTerminal(input: { id: "${id}", name: "前台收银" }) { id name } }
    `);
    expect(result.updatePosTerminal.name).toBe('前台收银');
  });

  it('应删除 PosTerminal', async () => {
    const terminals = await adminClient.query(`query { posTerminals { id } }`);
    const id = terminals.posTerminals[0].id;
    
    const result = await adminClient.query(`
      mutation { deletePosTerminal(id: "${id}") }
    `);
    expect(result.deletePosTerminal).toBe(true);
    
    const after = await adminClient.query(`query { posTerminals { id } }`);
    expect(after.posTerminals.length).toBe(0);
  });

  it('创建重复 code 应报错', async () => {
    const stockLoc = await adminClient.query(`query { stockLocations { items { id } } }`);
    await adminClient.query(`
      mutation { createPosTerminal(input: { code: "POS-DUP", name: "T1", stockLocationId: "${stockLoc.stockLocations.items[0].id}" }) { id } }
    `);
    
    await expect(adminClient.query(`
      mutation { createPosTerminal(input: { code: "POS-DUP", name: "T2", stockLocationId: "${stockLoc.stockLocations.items[0].id}" }) { id } }
    `)).rejects.toThrow();
  });
});
```

- [ ] **Step 6: 构建+运行测试**

```bash
pnpm --filter @vcash/pos-plugin build
pnpm --filter @vcash/pos-plugin test
```
修复直到 6 个测试通过。

- [ ] **Step 7: Commit**

```bash
git -C e:\code add vcash/packages/vcash-pos-plugin/
git -C e:\code commit -m "feat(pos-plugin): PosTerminal 实体 + CRUD + GraphQL（6 测试通过）"
```

---

## Task 3: PosSession 实体 + 开班/关班服务

**Files:**
- Create: `packages/vcash-pos-plugin/src/entities/pos-session.entity.ts`
- Create: `packages/vcash-pos-plugin/src/services/pos-session.service.ts`
- Modify: `packages/vcash-pos-plugin/src/plugin.ts`
- Modify: `packages/vcash-pos-plugin/e2e/terminal-session.e2e-spec.ts`

- [ ] **Step 1: 创建 PosSession 实体**

```typescript
// src/entities/pos-session.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, CreateDateColumn, Index } from 'typeorm';
import { PosTerminal } from './pos-terminal.entity';
import { Administrator, StockLocation } from '@vendure/core';

@Entity()
export class PosSession {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @ManyToOne(() => PosTerminal)
  @Index()
  terminal: PosTerminal;
  @ManyToOne(() => StockLocation)
  stockLocation: StockLocation;
  @ManyToOne(() => Administrator)
  operator: Administrator;
  @ManyToOne(() => Administrator, { nullable: true })
  approver: Administrator | null;
  @Column({ type: 'varchar', default: 'open' })
  state: 'open' | 'closed';
  @Column({ type: 'datetime' }) openedAt: Date;
  @Column({ type: 'datetime', nullable: true }) closedAt: Date | null;
  @Column({ type: 'json', nullable: true })
  closeSummary: any | null;
  @Column({ type: 'int', default: 0 })
  openingFloat: number;
  @Column({ type: 'int', default: 0 })
  closingCash: number;
  @Column({ nullable: true })
  activeOrderId: number | null;
}
```

- [ ] **Step 2: 创建 PosSessionService**

实现：
- `openSession(terminalCode, operatorId, openingFloat)`: 校验终端 active + 无 open session → 创建 session + 创建空 Draft Order → 返回
- `closeSession(sessionId, closingCash, approverId?)`: 校验 session open → 生成对账单 → 标记 closed
- `findOpenSession(terminalId)`: 查终端的 open session
- `findMySession(operatorId)`: 查收银员的 open session

```typescript
// src/services/pos-session.service.ts
import { Injectable, UserInputError } from '@vendure/core';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import { PosSession } from '../entities/pos-session.entity';
import { PosTerminalService } from './pos-terminal.service';
import { ShiftReportService } from './shift-report.service';

@Injectable()
export class PosSessionService {
  constructor(
    @InjectConnection() private connection: Connection,
    private terminalService: PosTerminalService,
  ) {}

  async openSession(input: {
    terminalCode: string;
    operatorId: number;
    openingFloat: number;
  }): Promise<PosSession> {
    const terminal = await this.terminalService.findByCode(input.terminalCode);
    if (!terminal) throw new UserInputError(`终端 ${input.terminalCode} 不存在`);
    if (!terminal.active) throw new UserInputError(`终端 ${input.terminalCode} 已停用`);

    const existing = await this.findOpenSession(terminal.id);
    if (existing) throw new UserInputError(`终端 ${input.terminalCode} 已有开着的班次 ${existing.code}`);

    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    const count = await this.connection.getRepository(PosSession).count({
      where: { code: Like(`${dateStr}%`) },
    });
    const code = `S${dateStr}-${String(count + 1).padStart(3, '0')}`;

    const session = new PosSession();
    session.code = code;
    session.terminal = terminal;
    session.stockLocation = terminal.stockLocation;
    session.operator = { id: input.operatorId } as any;
    session.state = 'open';
    session.openedAt = new Date();
    session.openingFloat = input.openingFloat;
    session.activeOrderId = null;

    return this.connection.getRepository(PosSession).save(session);
  }

  async closeSession(input: {
    sessionId: number;
    closingCash: number;
    approverId?: number;
    closeSummary?: any;
  }): Promise<PosSession> {
    const session = await this.connection.getRepository(PosSession).findOne({
      where: { id: input.sessionId },
      relations: ['terminal', 'operator', 'stockLocation'],
    });
    if (!session) throw new UserInputError(`班次 ${input.sessionId} 不存在`);
    if (session.state !== 'open') throw new UserInputError(`班次 ${session.code} 已关闭`);

    session.state = 'closed';
    session.closedAt = new Date();
    session.closingCash = input.closingCash;
    session.closeSummary = input.closeSummary ?? null;
    if (input.approverId) {
      session.approver = { id: input.approverId } as any;
    }
    session.activeOrderId = null;

    return this.connection.getRepository(PosSession).save(session);
  }

  async findOpenSession(terminalId: number): Promise<PosSession | undefined> {
    return this.connection.getRepository(PosSession).findOne({
      where: { terminal: { id: terminalId }, state: 'open' },
      relations: ['terminal', 'operator', 'stockLocation'],
    });
  }

  async findMySession(operatorId: number): Promise<PosSession | undefined> {
    return this.connection.getRepository(PosSession).findOne({
      where: { operator: { id: operatorId }, state: 'open' },
      relations: ['terminal', 'stockLocation'],
    });
  }

  async findOne(id: number): Promise<PosSession | undefined> {
    return this.connection.getRepository(PosSession).findOne({
      where: { id },
      relations: ['terminal', 'operator', 'approver', 'stockLocation'],
    });
  }
}
```

注意：需 import `Like` from typeorm。closeSession 中的 closeSummary 由 ShiftReportService 生成（Task 6），此处先接受外部传入。

- [ ] **Step 3: 更新 plugin.ts 注册 PosSession**

在 imports/ entities/ providers 中添加 PosSession + PosSessionService。

- [ ] **Step 4: 在 admin-pos.resolver.ts 添加 session 相关 mutation**

创建 `src/resolvers/admin-pos.resolver.ts`，先实现 openSession/closeSession/myPosSession：

```typescript
import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { Allow, Ctx, RequestContext, UserInputError } from '@vendure/core';
import { PosSessionService } from '../services/pos-session.service';
import { POS_PERMISSIONS } from '../constants';

@Resolver()
export class AdminPosResolver {
  constructor(private sessionService: PosSessionService) {}

  @Query()
  @Allow(POS_PERMISSIONS.SESSION_READ)
  async myPosSession(@Ctx() ctx: RequestContext): Promise<any | null> {
    const adminId = ctx.activeUserId;
    if (!adminId) return null;
    const session = await this.sessionService.findMySession(adminId);
    return session ?? null;
  }

  @Mutation()
  @Allow(POS_PERMISSIONS.SESSION_OPEN)
  async openSession(@Args('input') input: any, @Ctx() ctx: RequestContext): Promise<any> {
    const adminId = ctx.activeUserId;
    if (!adminId) throw new UserInputError('未登录');
    return this.sessionService.openSession({
      terminalCode: input.terminalCode,
      operatorId: adminId,
      openingFloat: input.openingFloat ?? 0,
    });
  }

  @Mutation()
  @Allow(POS_PERMISSIONS.SESSION_CLOSE)
  async closeSession(@Args('input') input: any, @Ctx() ctx: RequestContext): Promise<any> {
    const session = await this.sessionService.closeSession({
      sessionId: parseInt(input.sessionId),
      closingCash: input.closingCash ?? 0,
      approverId: input.approverId ? parseInt(input.approverId) : undefined,
    });
    return { session, summary: session.closeSummary };
  }
}
```

- [ ] **Step 5: 更新 plugin.ts 注册 AdminPosResolver**

- [ ] **Step 6: 扩展 e2e 测试（在 terminal-session.e2e-spec.ts 追加 session 测试）**

追加测试：
- 开班（openSession）→ 返回 session code 以 S 开头
- 同终端重复开班 → 报错
- myPosSession 查询 → 返回当前 session
- 关班（closeSession）→ state=closed
- 关班后 myPosSession → null

- [ ] **Step 7: 构建+测试**

```bash
pnpm --filter @vcash/pos-plugin build
pnpm --filter @vcash/pos-plugin test
```

- [ ] **Step 8: Commit**

```bash
git -C e:\code add vcash/packages/vcash-pos-plugin/
git -C e:\code commit -m "feat(pos-plugin): PosSession 实体 + 开班/关班服务"
```

---

## Task 4: Order/OrderLine/Payment custom fields

**Files:**
- Create: `packages/vcash-pos-plugin/src/custom-fields/order-custom-fields.ts`
- Create: `packages/vcash-pos-plugin/src/custom-fields/order-line-custom-fields.ts`
- Create: `packages/vcash-pos-plugin/src/custom-fields/payment-custom-fields.ts`
- Modify: `packages/vcash-pos-plugin/src/plugin.ts`

- [ ] **Step 1: 创建 order-custom-fields.ts**

```typescript
import { CustomFieldConfig, ID } from '@vendure/core';

export const orderCustomFields: CustomFieldConfig[] = [
  { name: 'posSessionId', type: 'int', nullable: true, public: false, description: '关联班次 ID' },
  { name: 'orderType', type: 'string', nullable: false, defaultValue: 'sale',
    options: [{ value: 'sale' }, { value: 'refund' }, { value: 'hold' }], public: false },
  { name: 'refundedOrderId', type: 'int', nullable: true, public: false, description: '退货单关联的原销售单 ID' },
  { name: 'shiftId', type: 'int', nullable: true, public: false, description: '冗余 shift_id' },
  { name: 'terminalCode', type: 'string', nullable: true, public: false },
  { name: 'aggregatePayStatus', type: 'string', nullable: true,
    options: [{ value: 'pending' }, { value: 'confirmed' }, { value: 'settled' }, { value: 'failed' }], public: false },
];
```

- [ ] **Step 2: 创建 order-line-custom-fields.ts**

```typescript
import { CustomFieldConfig } from '@vendure/core';

export const orderLineCustomFields: CustomFieldConfig[] = [
  { name: 'originalPrice', type: 'int', nullable: false, defaultValue: 0, public: false },
  { name: 'discount', type: 'int', nullable: false, defaultValue: 100, public: false },
  { name: 'memberPriceApplied', type: 'boolean', defaultValue: false, public: false },
  { name: 'isGift', type: 'boolean', defaultValue: false, public: false },
  { name: 'note', type: 'string', nullable: true, public: false },
];
```

- [ ] **Step 3: 创建 payment-custom-fields.ts**

```typescript
import { CustomFieldConfig } from '@vendure/core';

export const paymentCustomFields: CustomFieldConfig[] = [
  { name: 'aggregatePayCode', type: 'string', nullable: true, public: false },
  { name: 'aggregatePayStatus', type: 'string', nullable: true,
    options: [{ value: 'pending' }, { value: 'confirmed' }, { value: 'settled' }, { value: 'failed' }, { value: 'refunded' }], public: false },
  { name: 'needsManualRefund', type: 'boolean', defaultValue: false, public: false },
  { name: 'posSessionId', type: 'int', nullable: true, public: false },
];
```

- [ ] **Step 4: 在 plugin.ts 的 configuration 中注册 custom fields**

```typescript
configuration: (config) => {
  config.customFields = {
    ...config.customFields,
    Order: [...(config.customFields?.Order ?? []), ...orderCustomFields],
    OrderLine: [...(config.customFields?.OrderLine ?? []), ...orderLineCustomFields],
    Payment: [...(config.customFields?.Payment ?? []), ...paymentCustomFields],
  };
  return config;
},
```

- [ ] **Step 5: 构建+运行现有测试确认无回归**

```bash
pnpm --filter @vcash/pos-plugin build
pnpm --filter @vcash/pos-plugin test
```

- [ ] **Step 6: Commit**

```bash
git -C e:\code add vcash/packages/vcash-pos-plugin/
git -C e:\code commit -m "feat(pos-plugin): Order/OrderLine/Payment custom fields"
```

---

## Task 5: PosOrderService（加商品/结账）+ Admin GraphQL

**Files:**
- Create: `packages/vcash-pos-plugin/src/services/pos-order.service.ts`
- Modify: `packages/vcash-pos-plugin/src/resolvers/admin-pos.resolver.ts`
- Modify: `packages/vcash-pos-plugin/e2e/pos-flow.e2e-spec.ts`（新建完整收银流程测试）

- [ ] **Step 1: 创建 PosOrderService**

核心方法：
- `ensureActiveOrder(session)`: 无 activeOrderId 则创建 Draft Order（绑定 stockLocationCode + posSessionId custom field），返回 Order
- `addPosItem(ctx, session, input)`: 调用 OrderService.addItemToOrder，设置 OrderLine custom fields（discount/originalPrice/isGift）
- `updatePosItem(ctx, orderLineId, input)`: 修改数量/折扣
- `checkoutPosOrder(ctx, session, input)`: transitionToState 到 ArrangingPayment → 创建 Payment → PaymentSettled

```typescript
// src/services/pos-order.service.ts
import { Injectable, UserInputError } from '@vendure/core';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import { Order, OrderService, ProductService, RequestContext, IDs } from '@vendure/core';
import { PosSession } from '../entities/pos-session.entity';
import { ORDER_TYPE } from '../constants';

@Injectable()
export class PosOrderService {
  constructor(
    @InjectConnection() private connection: Connection,
    private orderService: OrderService,
    private productService: ProductService,
  ) {}

  async ensureActiveOrder(ctx: RequestContext, session: PosSession): Promise<Order> {
    if (session.activeOrderId) {
      const order = await this.orderService.findOne(ctx, session.activeOrderId);
      if (order && order.active) return order;
    }
    // 创建新 Draft Order
    const order = await this.orderService.create(ctx, {
      stockLocationCode: session.stockLocation.code,
      customFields: {
        posSessionId: session.id,
        orderType: ORDER_TYPE.SALE,
        terminalCode: session.terminal.code,
      },
    });
    // 更新 session.activeOrderId
    await this.connection.getRepository(PosSession).update(session.id, { activeOrderId: order.id });
    session.activeOrderId = order.id;
    return order;
  }

  async addPosItem(ctx: RequestContext, session: PosSession, input: {
    productVariantId: string;
    quantity: number;
    discount?: number;
    isGift?: boolean;
    note?: string;
  }): Promise<Order> {
    const order = await this.ensureActiveOrder(ctx, session);
    
    // 查商品变体获取原价
    const product = await this.productService.findOneByPrimarySlug(ctx, input.productVariantId);
    if (!product) throw new UserInputError(`商品 ${input.productVariantId} 不存在`);
    
    const variant = product.variantList.items[0];
    if (!variant) throw new UserInputError(`商品 ${input.productVariantId} 无变体`);
    
    const orderLine = await this.orderService.addItemToOrder(ctx, order.id, [variant.id], input.quantity);
    
    // 设置 OrderLine custom fields
    if (input.discount || input.isGift || input.note) {
      await this.orderService.updateOrderLineCustomFields(ctx, orderLine.id, {
        originalPrice: variant.price,
        discount: input.discount ?? 100,
        isGift: input.isGift ?? false,
        note: input.note ?? null,
        memberPriceApplied: (input.discount ?? 100) < 100,
      });
    }
    
    return this.orderService.findOne(ctx, order.id) as Promise<Order>;
  }

  async checkoutPosOrder(ctx: RequestContext, session: PosSession, input: {
    payments: Array<{ method: string; amount: number; aggregatePayCode?: string }>;
  }): Promise<{ order: Order; payments: any[] }> {
    const order = await this.ensureActiveOrder(ctx, session);
    if (order.lines.length === 0) throw new UserInputError('购物车为空');
    
    // transitionToState: ArrangingPayment
    await this.orderService.transitionToState(ctx, order.id, 'ArrangingPayment');
    
    // 创建 Payment（MVP 现金直接 settled）
    const payments = [];
    for (const pay of input.payments) {
      // 调用 OrderService.addPaymentToOrder 或 PaymentService
      // MVP: 简化为记录支付明细
      payments.push(pay);
    }
    
    // transitionToState: PaymentSettled
    await this.orderService.transitionToState(ctx, order.id, 'PaymentSettled');
    
    // 清除 activeOrderId
    await this.connection.getRepository(PosSession).update(session.id, { activeOrderId: null });
    
    return { order: await this.orderService.findOne(ctx, order.id) as Promise<Order>, payments };
  }
}
```

注意：Vendure 3.6.4 的 OrderService API 可能与上述有差异，subagent 需用 Grep 查 `e:\code\vendure\packages\core\src\service\services\order.service.ts` 确认方法签名（addItemToOrder 参数、create 参数、transitionToState 等），按实际 API 调整。

- [ ] **Step 2: 在 admin-pos.resolver.ts 添加 addPosItem/checkoutPosOrder mutation**

需要中间件校验：调用者有活跃 session（通过 myPosSession 获取）。

- [ ] **Step 3: 更新 plugin.ts 注册 PosOrderService**

- [ ] **Step 4: 编写完整收银流程 e2e 测试**

`e2e/pos-flow.e2e-spec.ts`：
- 创建 StockLocation + PosTerminal
- openSession
- addPosItem（可口可乐 x2）
- addPosItem（雪碧 x1）
- checkoutPosOrder（现金支付）
- 校验 Order state=PaymentSettled
- closeSession
- 校验 session state=closed

- [ ] **Step 5: 构建+测试**

```bash
pnpm --filter @vcash/pos-plugin build
pnpm --filter @vcash/pos-plugin test
```

- [ ] **Step 6: Commit**

```bash
git -C e:\code add vcash/packages/vcash-pos-plugin/
git -C e:\code commit -m "feat(pos-plugin): PosOrderService 加商品/结账 + 完整收银流程测试"
```

---

## Task 6: ShiftReportService（交班对账单）

**Files:**
- Create: `packages/vcash-pos-plugin/src/services/shift-report.service.ts`
- Modify: `packages/vcash-pos-plugin/src/services/pos-session.service.ts`（closeSession 调用 ShiftReportService 生成 summary）
- Modify: `packages/vcash-pos-plugin/src/resolvers/admin-pos.resolver.ts`（添加 shiftReportPreview query）
- Create: `packages/vcash-pos-plugin/e2e/shift-report.e2e-spec.ts`

- [ ] **Step 1: 创建 ShiftReportService**

```typescript
// src/services/shift-report.service.ts
import { Injectable } from '@vendure/core';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import { Order } from '@vendure/core';
import { ShiftSummary } from '../types';

@Injectable()
export class ShiftReportService {
  constructor(@InjectConnection() private connection: Connection) {}

  async generateSummary(sessionId: number, closingCash?: number): Promise<ShiftSummary> {
    // 查询该 session 的所有 Order（通过 customFields.posSessionId = sessionId）
    // 用 raw query 或 OrderService
    const orders = await this.connection.getRepository(Order)
      .createQueryBuilder('order')
      .where('order.customFieldsJson ->> \'$.posSessionId\' = :sid', { sid: String(sessionId) })
      .getMany();

    const normalOrders = orders.filter(o => (o as any).customFields?.orderType === 'sale');
    const refundOrders = orders.filter(o => (o as any).customFields?.orderType === 'refund');
    const heldOrders = orders.filter(o => (o as any).customFields?.orderType === 'hold');

    const totalAmount = normalOrders.reduce((s, o) => s + o.total, 0);
    const refundAmount = refundOrders.reduce((s, o) => s + Math.abs(o.total), 0);

    // 支付方式汇总（需查 Payment 表）
    // MVP: 简化为按 order.customFields 记录的支付方式
    const paymentsByMethod: any[] = []; // TODO: 查 Payment

    const warnings: string[] = [];
    if (closingCash !== undefined) {
      const expectedCash = this.calculateExpectedCash(orders);
      const diff = closingCash - expectedCash;
      if (Math.abs(diff) > 1) {
        warnings.push(`实交现金与系统差额 ${diff.toFixed(2)} 元`);
      }
    }

    return {
      orders: {
        totalCount: orders.length,
        totalAmount,
        normalCount: normalOrders.length,
        refundCount: refundOrders.length,
        refundAmount,
        heldCount: heldOrders.length,
      },
      paymentsByMethod,
      warnings,
    };
  }

  private calculateExpectedCash(orders: Order[]): number {
    // MVP: 假设所有 payment.method='cash' 的金额之和
    return 0; // TODO: 实现现金计算
  }
}
```

- [ ] **Step 2: 修改 PosSessionService.closeSession 调用 ShiftReportService**

在 closeSession 中，如果未传 closeSummary，则调用 `this.shiftReportService.generateSummary(sessionId, closingCash)` 生成。

- [ ] **Step 3: 在 admin-pos.resolver.ts 添加 shiftReportPreview query**

```typescript
@Query()
@Allow(POS_PERMISSIONS.SESSION_READ)
async shiftReportPreview(@Args('sessionId') sessionId: string, @Ctx() ctx: RequestContext): Promise<any> {
  return this.shiftReportService.generateSummary(parseInt(sessionId));
}
```

- [ ] **Step 4: 编写交班对账测试**

`e2e/shift-report.e2e-spec.ts`：
- 开班 → 加商品 → 结账（多笔）→ 退货一笔 → shiftReportPreview → 校验统计 → 关班 → 校验 closeSummary

- [ ] **Step 5: 构建+测试**

- [ ] **Step 6: Commit**

```bash
git -C e:\code add vcash/packages/vcash-pos-plugin/
git -C e:\code commit -m "feat(pos-plugin): ShiftReportService 交班对账单"
```

---

## Task 7: 聚合码支付 + 退货 + 收尾

**Files:**
- Create: `packages/vcash-pos-plugin/src/services/aggregate-pay.service.ts`
- Create: `packages/vcash-pos-plugin/src/services/refund.service.ts`
- Modify: `packages/vcash-pos-plugin/src/resolvers/admin-pos.resolver.ts`（聚合码 mutation）
- Create: `packages/vcash-pos-plugin/src/resolvers/admin-refund.resolver.ts`
- Create: `packages/vcash-pos-plugin/e2e/aggregate-pay.e2e-spec.ts`
- Create: `packages/vcash-pos-plugin/e2e/refund.e2e-spec.ts`
- Modify: `packages/vcash-pos-plugin/src/plugin.ts`

- [ ] **Step 1: 创建 AggregatePayService**

方法：
- `createPendingPay(ctx, orderId, amount)`: 创建 Payment（aggregatePayStatus=pending）
- `confirmPay(ctx, paymentId)`: pending → confirmed
- `markSettled(ctx, paymentId)`: confirmed → settled（交班时批量）
- `markFailed(ctx, paymentId)`: pending → failed（超时）

- [ ] **Step 2: 创建 RefundService**

方法：
- `createRefundOrder(ctx, input: { originalOrderId, refundLines })`: 创建 orderType=refund 的 Order，复制原单行（负数量），stockLocationCode 同原单，创建负 Payment

- [ ] **Step 3: 在 resolvers 添加聚合码 + 退货 mutation**

- [ ] **Step 4: 编写聚合码测试**

`e2e/aggregate-pay.e2e-spec.ts`：
- 结账时创建 pending payment → confirmPay → 校验状态 confirmed

- [ ] **Step 5: 编写退货测试**

`e2e/refund.e2e-spec.ts`：
- 先完成一笔销售 → createRefundOrder（退 1 件）→ 校验退货 Order orderType=refund + refundedOrderId 关联 + 库存回退

- [ ] **Step 6: 运行全部测试**

```bash
pnpm --filter @vcash/pos-plugin test
pnpm --filter @vcash/server test
```
所有测试通过。

- [ ] **Step 7: Commit**

```bash
git -C e:\code add vcash/packages/vcash-pos-plugin/
git -C e:\code commit -m "feat(pos-plugin): 聚合码支付 + 退货退款 + 全测试通过"
```

---

## Phase 2 完成标准

- [ ] vcash-pos-plugin 包创建并注册到 server
- [ ] PosTerminal 实体 + CRUD GraphQL（6 测试）
- [ ] PosSession 实体 + 开班/关班（session 测试）
- [ ] Order/OrderLine/Payment custom fields 注册
- [ ] PosOrderService 加商品/结账（完整收银流程测试）
- [ ] ShiftReportService 交班对账单（对账测试）
- [ ] AggregatePayService 聚合码支付状态机（聚合码测试）
- [ ] RefundService 退货退款（退货测试）
- [ ] 全部测试通过（pos-plugin + server 无回归）
- [ ] 所有 commit 完成

---

## 后续 Phase 预告

- **Phase 3**: 前端在线收银（CashierView + CheckoutView + Apollo + Channel 切换）
- **Phase 4**: 离线能力（vcash-offline-plugin + IndexedDB）
- **Phase 5**: 退货与交班 UI（RefundView + ShiftView）
- **Phase 6**: 外设集成
- **Phase 7**: 测试完善 + 部署
