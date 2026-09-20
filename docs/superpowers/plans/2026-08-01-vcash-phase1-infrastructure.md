# vcash Phase 1: 基础设施脚手架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 vcash 项目脚手架（pnpm workspace），配置可启动的 Vendure 实例，注册 cjk-plugin + member-level-plugin，验证多租户（Channel）+ 多仓库（StockLocation）基础能力。

**Architecture:** pnpm monorepo（packages/web/server 三顶层），server 作为 Vendure 实例入口注册复用插件，Phase 1 不创建 vcash 自有插件（Phase 2 起）。验证用 @vendure/testing 集成测试 + populate 测试数据。

**Tech Stack:** Node.js 20+, pnpm 9+, TypeScript 5, Vendure 2.x, @vendure/cjk-plugin, @vendure/member-level-plugin, Vitest, SQLite（测试）/ PostgreSQL（生产）

**Spec 参考:** `docs/superpowers/specs/2026-08-01-vcash-redesign-design.md` §2 整体架构、§2.2 多租户映射、§2.3 目录结构、§4.6 插件依赖关系

---

## File Structure

Phase 1 涉及文件（全部新建，vcash 目录当前仅有 docs/）：

```
e:\code\vcash\
├── package.json                    # workspace root
├── pnpm-workspace.yaml             # workspace 配置
├── tsconfig.base.json              # 共享 tsconfig
├── .gitignore
├── .nvmrc                          # Node 版本锁定
├── server/
│   ├── package.json                # Vendure 实例依赖
│   ├── tsconfig.json               # extends base
│   ├── vendure-config.ts           # Vendure 配置入口（注册插件、DB、API path）
│   ├── populate.ts                 # 测试数据填充脚本（Channel + StockLocation + 商品）
│   └── index.ts                    # 启动入口（bootstrap）
├── packages/
│   ├── vcash-pos-plugin/           # Phase 2 创建，Phase 1 仅占位 .gitkeep
│   │   └── .gitkeep
│   └── vcash-offline-plugin/       # Phase 2 创建，Phase 1 仅占位 .gitkeep
│       └── .gitkeep
└── web/                            # Phase 3 创建，Phase 1 仅占位 .gitkeep
    └── .gitkeep
```

**职责边界：**
- `server/vendure-config.ts`：唯一配置入口，注册所有插件、DB 连接、API path、authOptions
- `server/populate.ts`：测试数据填充，创建 2 个 Channel（朝阳连锁/海淀连锁）+ 各自 StockLocation + 共享商品
- `server/index.ts`：启动入口，生产用 `vpl-bootstrap`，开发用 `vpl-develop`

---

## Task 1: 初始化 pnpm workspace 脚手架

**Files:**
- Create: `e:\code\vcash\package.json`
- Create: `e:\code\vcash\pnpm-workspace.yaml`
- Create: `e:\code\vcash\tsconfig.base.json`
- Create: `e:\code\vcash\.gitignore`
- Create: `e:\code\vcash\.nvmrc`
- Create: `e:\code\vcash\packages\vcash-pos-plugin\.gitkeep`
- Create: `e:\code\vcash\packages\vcash-offline-plugin\.gitkeep`
- Create: `e:\code\vcash\web\.gitkeep`

- [ ] **Step 1: 创建 workspace root package.json**

```json
{
  "name": "vcash",
  "version": "0.1.0",
  "private": true,
  "description": "vcash POS 系统 - Vendure 多租户多仓库收银",
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "dev": "pnpm --filter server dev",
    "build:server": "pnpm --filter server build",
    "populate": "pnpm --filter server populate"
  },
  "devDependencies": {
    "typescript": "^5.4.0"
  },
  "packageManager": "pnpm@9.12.0",
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: 创建 pnpm-workspace.yaml**

```yaml
packages:
  - 'server'
  - 'packages/*'
  - 'web'
```

- [ ] **Step 3: 创建 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

- [ ] **Step 4: 创建 .gitignore**

```gitignore
node_modules/
dist/
build/
.env
.env.local
*.log
.DS_Store
.vendure/
sqlite.db
```

- [ ] **Step 5: 创建 .nvmrc**

```
20
```

- [ ] **Step 6: 创建占位 .gitkeep 文件**

创建以下空文件（确保目录被 git 跟踪）：
- `packages/vcash-pos-plugin/.gitkeep`
- `packages/vcash-offline-plugin/.gitkeep`
- `web/.gitkeep`

- [ ] **Step 7: 验证 workspace 初始化**

Run（在 `e:\code\vcash` 目录）:
```bash
pnpm install
```
Expected: 无报错，生成 `pnpm-lock.yaml`（即使没有依赖也能成功）

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .nvmrc packages/ web/
git commit -m "chore: 初始化 pnpm workspace 脚手架"
```

---

## Task 2: 创建 server 包与 Vendure 配置

**Files:**
- Create: `e:\code\vcash\server\package.json`
- Create: `e:\code\vcash\server\tsconfig.json`
- Create: `e:\code\vcash\server\vendure-config.ts`
- Create: `e:\code\vcash\server\index.ts`

- [ ] **Step 1: 创建 server/package.json**

```json
{
  "name": "@vcash/server",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vpl-bootstrap --watch",
    "start": "node dist/index.js",
    "build": "tsc",
    "populate": "ts-node populate.ts"
  },
  "dependencies": {
    "@vendure/core": "^2.2.0",
    "@vendure/cjk-plugin": "^2.2.0",
    "@vendure/member-level-plugin": "^2.2.0",
    "@vendure/email-plugin": "^2.2.0",
    "@vendure/asset-server-plugin": "^2.2.0",
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: 创建 server/tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: 创建 server/vendure-config.ts**

```typescript
import { DefaultLogger, LogLevel, VendureConfig } from '@vendure/core';
import { compileConfig } from '@vendure/core/cli/compile-config';
import { CjkPlugin } from '@vendure/cjk-plugin';
import { MemberLevelPlugin } from '@vendure/member-level-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { EmailPlugin } from '@vendure/email-plugin';
import path from 'node:path';

export const config: VendureConfig = {
  apiOptions: {
    adminApiPath: 'admin-api',
    shopApiPath: 'shop-api',
    port: 3000,
    hostname: '0.0.0.0',
    cors: {
      origin: true,
      credentials: true,
    },
  },
  authOptions: {
    tokenMethod: 'bearer',
    requireVerification: false,
    cookieOptions: {
      sameSite: 'lax',
    },
  },
  dbConnectionOptions: {
    type: 'better-sqlite3',
    database: path.join(__dirname, 'sqlite.db'),
    synchronize: true,
    logging: false,
  },
  logger: new DefaultLogger({ level: LogLevel.Info }),
  plugins: [
    CjkPlugin.init({}),
    MemberLevelPlugin.init({}),
    AssetServerPlugin.init({
      assetUploadDir: path.join(__dirname, 'assets'),
      route: 'assets',
    }),
    EmailPlugin.init({
      devMode: true,
      outputPath: path.join(__dirname, 'email-output'),
      transport: {
        type: 'file',
      },
    }),
  ],
};

// 编译配置（开发模式 watch 用）
export const compiledConfig = compileConfig(config);
```

- [ ] **Step 4: 创建 server/index.ts（启动入口）**

```typescript
import { bootstrap } from '@vendure/core';
import { config } from './vendure-config';

bootstrap(config).catch((err) => {
  console.error('Vendure 启动失败:', err);
  process.exit(1);
});
```

- [ ] **Step 5: 安装依赖**

Run（在 `e:\code\vcash` 目录）:
```bash
pnpm install
```
Expected: 依赖安装成功，无 peer dependency 报错（如有 cjk-plugin/member-level-plugin 版本不匹配，调整版本号）

- [ ] **Step 6: 验证 TypeScript 编译**

Run:
```bash
pnpm --filter @vcash/server build
```
Expected: 无编译错误，生成 `server/dist/` 目录

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/tsconfig.json server/vendure-config.ts server/index.ts pnpm-lock.yaml
git commit -m "feat(server): 创建 Vendure 配置入口，注册 cjk-plugin + member-level-plugin"
```

---

## Task 3: 编写多租户多仓库验证测试（先写失败测试）

**Files:**
- Create: `e:\code\vcash\server\__tests__\multi-tenant-stock.spec.ts`
- Create: `e:\code\vcash\server\vitest.config.ts`

**说明：** Phase 1 用 @vendure/testing 创建测试环境，验证两个核心能力：(1) Channel 隔离商品定价；(2) StockLocation 隔离库存。这是后续 POS 业务的基础。

- [ ] **Step 1: 安装测试依赖**

修改 `server/package.json`，在 devDependencies 增加：
```json
    "@vendure/testing": "^2.2.0",
    "vitest": "^1.6.0"
```

Run:
```bash
pnpm install
```

- [ ] **Step 2: 创建 server/vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
```

在 server/package.json 的 scripts 增加：
```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: 创建测试数据 CSV 文件**

Create: `e:\code\vcash\server\__tests__\fixtures\products.csv`

```csv
sku,name,price,customFields
COKE-330,可口可乐 330ml,300,
SPRITE-500,雪碧 500ml,350,
APPLE-001,苹果（计重）,800,"{""isWeighted"":true}"
```

Create: `e:\code\vcash\server\__tests__\fixtures\customers.csv`

```csv
identifier,firstName,lastName,emailAddress
member001,张,三,member001@test.com
```

- [ ] **Step 4: 编写多租户多仓库验证测试（此时应失败，因无 populate 数据）**

Create: `e:\code\vcash\server\__tests__\multi-tenant-stock.spec.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnvironment, registerInitializer, SqljsInitializer } from '@vendure/testing';
import { testConfig } from '@vendure/testing';
import { DefaultLogger, LogLevel } from '@vendure/core';
import path from 'node:path';
import { config } from '../vendure-config';

registerInitializer('sqljs', new SqljsInitializer('__data__'));

describe('多租户多仓库基础能力', () => {
  const { server, adminClient, shopClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    plugins: config.plugins,
  });

  beforeAll(async () => {
    await server.init({
      initialData: {
        defaultChannel: true,
        defaultLanguage: 'zh',
        currencies: [
          { code: 'CNY', symbol: '¥', symbolPosition: 'prefix' },
        ],
        countries: [
          { code: 'CN', language: 'zh', currencyCode: 'CNY', enabled: true },
        ],
        roles: [
          { code: 'cashier', permissions: ['Authenticated'] },
          { code: 'shift-manager', permissions: ['Authenticated'] },
        ],
        channels: [
          {
            code: 'chaoyang-chain',
            defaultCurrencyCode: 'CNY',
            defaultLanguageCode: 'zh',
            pricesIncludeTax: false,
          },
          {
            code: 'haidian-chain',
            defaultCurrencyCode: 'CNY',
            defaultLanguageCode: 'zh',
            pricesIncludeTax: false,
          },
        ],
        stockLocations: [
          { name: '朝阳店-总店', code: 'CY-001' },
          { name: '朝阳店-分店', code: 'CY-002' },
          { name: '海淀店-总店', code: 'HD-001' },
        ],
        shippingMethods: [],
        paymentMethods: [],
        taxRates: [],
      },
      productsCsvPath: path.join(__dirname, 'fixtures/products.csv'),
      customerCsvPath: path.join(__dirname, 'fixtures/customers.csv'),
    });
    await adminClient.asSuperAdmin();
  }, 120000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应创建 2 个 Channel（朝阳连锁 + 海淀连锁）', async () => {
    const { channels } = await adminClient.query(
      `query { channels { id code name } }`
    );
    expect(channels.length).toBeGreaterThanOrEqual(3); // default + 2
    const codes = channels.map((c: any) => c.code);
    expect(codes).toContain('chaoyang-chain');
    expect(codes).toContain('haidian-chain');
  });

  it('应创建 3 个 StockLocation', async () => {
    const { stockLocations } = await adminClient.query(
      `query { stockLocations { id name code } }`
    );
    expect(stockLocations.length).toBe(3);
    const names = stockLocations.map((s: any) => s.name);
    expect(names).toContain('朝阳店-总店');
    expect(names).toContain('朝阳店-分店');
    expect(names).toContain('海淀店-总店');
  });

  it('商品应可查询（populate 成功）', async () => {
    const { products } = await adminClient.query(
      `query { products { items { id name sku } } }`
    );
    expect(products.items.length).toBeGreaterThanOrEqual(3);
    const skus = products.items.map((p: any) => p.sku);
    expect(skus).toContain('COKE-330');
    expect(skus).toContain('SPRITE-500');
    expect(skus).toContain('APPLE-001');
  });

  it('cashier 角色应存在', async () => {
    const { roles } = await adminClient.query(
      `query { roles { id code description } }`
    );
    const codes = roles.map((r: any) => r.code);
    expect(codes).toContain('cashier');
    expect(codes).toContain('shift-manager');
  });
});
```

- [ ] **Step 5: 运行测试验证失败**

Run:
```bash
pnpm --filter @vcash/server test
```
Expected: FAIL（测试用例因无 populate 或配置问题失败。具体错误可能是：initialData.channels 字段不被 @vendure/testing 直接支持，需调整测试数据结构。记录失败原因用于下一步修复。）

- [ ] **Step 6: Commit（保留失败测试）**

```bash
git add server/__tests__/ server/vitest.config.ts server/package.json pnpm-lock.yaml
git commit -m "test(server): 编写多租户多仓库验证测试（失败中）"
```

---

## Task 4: 修复测试数据结构使测试通过

**Files:**
- Modify: `e:\code\vcash\server\__tests__\multi-tenant-stock.spec.ts`

**说明：** @vendure/testing 的 initialData 不直接支持 channels 数组（Channel 在 populate 后单独创建）。调整测试策略：populate 默认 Channel + 商品，然后通过 Admin API 手动创建第二个 Channel + StockLocation。

- [ ] **Step 1: 重写测试，分两阶段（populate 基础数据 + API 创建多租户）**

修改 `server/__tests__/multi-tenant-stock.spec.ts`，将 initialData 简化为单 Channel，多 Channel/StockLocation 用 Admin API 创建：

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { DefaultLogger, LogLevel } from '@vendure/core';
import path from 'node:path';
import { config } from '../vendure-config';

registerInitializer('sqljs', new SqljsInitializer('__data__'));

const CREATE_CHANNEL = `
  mutation CreateChannel($input: CreateChannelInput!) {
    createChannel(input: $input) {
      id
      code
      name
    }
  }
`;

const CREATE_STOCK_LOCATION = `
  mutation CreateStockLocation($input: CreateStockLocationInput!) {
    createStockLocation(input: $input) {
      id
      name
      code
    }
  }
`;

describe('多租户多仓库基础能力', () => {
  const { server, adminClient, shopClient } = createTestEnvironment({
    ...testConfig,
    logger: new DefaultLogger({ level: LogLevel.Error }),
    plugins: config.plugins,
  });

  beforeAll(async () => {
    await server.init({
      initialData: {
        defaultChannel: true,
        defaultLanguage: 'zh',
        currencies: [{ code: 'CNY', symbol: '¥', symbolPosition: 'prefix' }],
        countries: [{ code: 'CN', language: 'zh', currencyCode: 'CNY', enabled: true }],
        roles: [
          { code: 'cashier', permissions: ['Authenticated'] },
          { code: 'shift-manager', permissions: ['Authenticated'] },
        ],
        shippingMethods: [],
        paymentMethods: [],
        taxRates: [],
      },
      productsCsvPath: path.join(__dirname, 'fixtures/products.csv'),
      customerCsvPath: path.join(__dirname, 'fixtures/customers.csv'),
    });
    await adminClient.asSuperAdmin();
  }, 120000);

  afterAll(async () => {
    await server.destroy();
  });

  it('应创建第二个 Channel（海淀连锁）', async () => {
    const result = await adminClient.query(CREATE_CHANNEL, {
      input: {
        code: 'haidian-chain',
        token: 'haidian-chain',
        defaultCurrencyCode: 'CNY',
        defaultLanguageCode: 'zh',
        pricesIncludeTax: false,
      },
    });
    expect(result.createChannel.code).toBe('haidian-chain');
  });

  it('应创建 3 个 StockLocation', async () => {
    const locations = [
      { name: '朝阳店-总店', code: 'CY-001' },
      { name: '朝阳店-分店', code: 'CY-002' },
      { name: '海淀店-总店', code: 'HD-001' },
    ];
    for (const loc of locations) {
      const result = await adminClient.query(CREATE_STOCK_LOCATION, {
        input: { name: loc.name, code: loc.code },
      });
      expect(result.createStockLocation.code).toBe(loc.code);
    }
  });

  it('应查询到 2 个 Channel（默认 + 海淀）', async () => {
    const { channels } = await adminClient.query(
      `query { channels { id code } }`
    );
    expect(channels.length).toBe(2);
    const codes = channels.map((c: any) => c.code);
    expect(codes).toContain('__default_channel__');
    expect(codes).toContain('haidian-chain');
  });

  it('应查询到 3 个 StockLocation', async () => {
    const { stockLocations } = await adminClient.query(
      `query { stockLocations { id name code } }`
    );
    expect(stockLocations.length).toBe(3);
  });

  it('商品应可查询（populate 成功）', async () => {
    const { products } = await adminClient.query(
      `query { products { items { id name sku } } }`
    );
    expect(products.items.length).toBeGreaterThanOrEqual(3);
    const skus = products.items.map((p: any) => p.sku);
    expect(skus).toContain('COKE-330');
    expect(skus).toContain('SPRITE-500');
    expect(skus).toContain('APPLE-001');
  });

  it('cashier 与 shift-manager 角色应存在', async () => {
    const { roles } = await adminClient.query(
      `query { roles { id code } }`
    );
    const codes = roles.map((r: any) => r.code);
    expect(codes).toContain('cashier');
    expect(codes).toContain('shift-manager');
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run:
```bash
pnpm --filter @vcash/server test
```
Expected: PASS（6 个测试用例全部通过）

- [ ] **Step 3: Commit**

```bash
git add server/__tests__/multi-tenant-stock.spec.ts
git commit -m "test(server): 多租户多仓库验证测试通过 - 2 Channel + 3 StockLocation + 商品 populate"
```

---

## Task 5: 创建 populate 脚本（开发环境数据填充）

**Files:**
- Create: `e:\code\vcash\server\populate.ts`

**说明：** 测试用 @vendure/testing，开发环境用 populate 脚本直接连本地 SQLite 填充数据，方便 `pnpm dev` 后立即有数据可用。

- [ ] **Step 1: 创建 populate.ts**

```typescript
import { bootstrap } from '@vendure/core';
import { populate } from '@vendure/core/cli';
import { config } from './vendure-config';

const initialData = {
  defaultChannel: true,
  defaultLanguage: 'zh',
  currencies: [{ code: 'CNY', symbol: '¥', symbolPosition: 'prefix' }],
  countries: [{ code: 'CN', language: 'zh', currencyCode: 'CNY', enabled: true }],
  roles: [
    { code: 'cashier', permissions: ['Authenticated'] },
    { code: 'shift-manager', permissions: ['Authenticated'] },
  ],
  shippingMethods: [],
  paymentMethods: [],
  taxRates: [],
};

async function run() {
  const app = await bootstrap(config);
  await populate(
    () => app,
    {
      ...initialData,
      productsCsvPath: require('path').join(__dirname, '__tests__/fixtures/products.csv'),
      customerCsvPath: require('path').join(__dirname, '__tests__/fixtures/customers.csv'),
    },
    {
      channelToken: '__default_channel__',
    }
  );
  
  // 创建第二个 Channel
  // 创建 StockLocation
  // 通过 Admin API（用 superadmin 登录后调用）
  // ... 此处简化，开发环境手动用 Admin API 创建
  
  console.log('populate 完成');
  await app.close();
}

run().catch((err) => {
  console.error('populate 失败:', err);
  process.exit(1);
});
```

- [ ] **Step 2: 验证 populate 脚本可执行**

Run:
```bash
pnpm populate
```
Expected: 输出 "populate 完成"，生成 `server/sqlite.db` 文件，无报错

- [ ] **Step 3: 验证 dev 启动后 Admin API 可用**

Run（在另一个终端）:
```bash
pnpm dev
```
等待启动完成后，用 curl 测试 Admin API：
```bash
curl -X POST http://localhost:3000/admin-api -H "Content-Type: application/json" -d '{"query":"{ adminMe { id } }"}'
```
Expected: 返回未认证错误（401），说明 Admin API 路径正确且服务运行中（此时未登录所以 401 是预期行为）

停止 dev server。

- [ ] **Step 4: Commit**

```bash
git add server/populate.ts
git commit -m "feat(server): 添加开发环境 populate 脚本"
```

---

## Task 6: 验证 dev 模式完整启动

**Files:**
- Modify: `e:\code\vcash\server\package.json`（修正 dev 脚本）

**说明：** Task 5 的 dev 用了 `vpl-bootstrap --watch`，但实际 Vendure 2.x 推荐用 `@vendure/cli` 的 develop 模式。修正并验证完整启动流程。

- [ ] **Step 1: 修正 server/package.json 的 scripts**

```json
  "scripts": {
    "dev": "ts-node index.ts",
    "start": "node dist/index.js",
    "build": "tsc",
    "populate": "ts-node populate.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  }
```

- [ ] **Step 2: 验证 dev 启动**

Run:
```bash
pnpm dev
```
Expected: 控制台输出 Vendure 启动日志，包含 "Vendure server now running on port 3000"，无报错

- [ ] **Step 3: 验证 Admin API 与 Shop API 路径**

在另一个终端执行：
```bash
curl -X POST http://localhost:3000/admin-api -H "Content-Type: application/json" -d "{\"query\":\"{ __typename }\"}"
curl -X POST http://localhost:3000/shop-api -H "Content-Type: application/json" -d "{\"query\":\"{ __typename }\"}"
```
Expected: 两个都返回 `{"data":{"__typename":"..."}}`，说明 API 路径配置正确

- [ ] **Step 4: 停止 dev server 并 Commit**

停止 dev server（Ctrl+C）

```bash
git add server/package.json
git commit -m "fix(server): 修正 dev 脚本用 ts-node 直接启动"
```

---

## Task 7: 更新 README 与 Phase 1 收尾

**Files:**
- Create: `e:\code\vcash\README.md`

- [ ] **Step 1: 创建 README.md**

```markdown
# vcash

基于 Vendure 的多租户多仓库 POS 收银系统。

## 技术栈

- 后端: Vendure 2.x + TypeScript
- 前端: Vue 3 + Pinia + Apollo（Phase 3 起）
- 数据库: SQLite（开发/测试）/ PostgreSQL（生产）
- 包管理: pnpm workspace

## 快速开始

```bash
# 安装依赖
pnpm install

# 填充测试数据
pnpm populate

# 启动开发服务器
pnpm dev
```

服务启动后：
- Admin API: http://localhost:3000/admin-api
- Shop API: http://localhost:3000/shop-api
- Admin UI: http://localhost:3000/admin

默认管理员账号: superadmin / superadmin

## 项目结构

```
packages/
  vcash-pos-plugin/      # POS 业务核心插件（Phase 2）
  vcash-offline-plugin/  # 离线同步插件（Phase 2）
web/                     # POS 前端 SPA（Phase 3）
server/                  # Vendure 实例入口
docs/                    # 设计文档与实施计划
```

## 文档

- [设计 Spec](docs/superpowers/specs/2026-08-01-vcash-redesign-design.md)
- [Phase 1 实施计划](docs/superpowers/plans/2026-08-01-vcash-phase1-infrastructure.md)

## 开发命令

```bash
pnpm test          # 运行所有测试
pnpm build         # 构建所有包
pnpm --filter @vcash/server test  # 仅运行 server 测试
```
```

- [ ] **Step 2: 运行全部测试确认无回归**

Run:
```bash
pnpm --filter @vcash/server test
```
Expected: 6 个测试用例全部 PASS

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: 添加 README"
```

- [ ] **Step 4: 推送 Phase 1 完整提交**

```bash
git log --oneline
```
Expected: 看到 7 个提交（Task 1-7 各一个），确认 Phase 1 完成

---

## Phase 1 完成标准

- [ ] pnpm workspace 脚手架就绪（3 顶层目录 + 占位）
- [ ] server 包可启动 Vendure 实例（Admin API + Shop API 路径正确）
- [ ] cjk-plugin + member-level-plugin 已注册且无冲突
- [ ] 多租户验证：可创建 2 个 Channel
- [ ] 多仓库验证：可创建 3 个 StockLocation
- [ ] 商品 populate 成功（3 个商品含计重商品）
- [ ] cashier + shift-manager 角色已创建
- [ ] 6 个集成测试全部通过
- [ ] README 文档就绪

---

## 后续 Phase 预告

- **Phase 2**: vcash-pos-plugin 核心（PosTerminal/PosSession 实体 + custom fields + 基础 GraphQL + 在线收银流程）
- **Phase 3**: 前端在线收银（CashierView + CheckoutView + Apollo 集成）
- **Phase 4**: 离线能力（vcash-offline-plugin + IndexedDB + 同步状态机）
- **Phase 5**: 退货与交班（RefundView + ShiftView + 对账单）
- **Phase 6**: 外设集成（扫码枪/电子秤/钱箱/ESC-POS）
- **Phase 7**: 测试完善 + 部署
