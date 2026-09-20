# vcash — POS 收银系统

> 基于 [Vendure](https://www.vendure.io) 的多租户多仓库 POS 收银解决方案。

## 目录

- [项目概述](#项目概述)
- [架构说明](#架构说明)
- [快速开始（本地开发）](#快速开始本地开发)
- [生产部署](#生产部署)
- [POS 操作指南](#pos-操作指南)
- [功能说明](#功能说明)
- [配置参考](#配置参考)
- [FAQ](#faq)

---

## 项目概述

vcash 是针对实体门店场景设计的 POS 收银系统，深度集成 Vendure 电商引擎，支持多门店（多渠道）、多仓库、多收银终端。

### 技术栈

| 层 | 技术 |
|---|---|
| 后端框架 | Vendure（Node.js / TypeScript / NestJS） |
| 数据库 | SQLite（开发）/ PostgreSQL（生产） |
| 前端 | Vue 3 + TypeScript + Element Plus |
| API | GraphQL（Apollo Client） |
| 包管理 | pnpm 9.12.0 |
| 测试 | Vitest（后端 e2e） |

### 核心功能

1. **POS 收银** — 商品选择、扫码枪、购物车、挂单/取单、多种支付方式
2. **会员价** — 会员等级、自定义折扣规则
3. **促销规则** — 满减、折扣、买赠，互斥最优算法
4. **离线同步** — 网络中断时离线销售，恢复后自动同步
5. **退款** — 支持全额/部分退款
6. **交班对账** — 班次内订单汇总、支付方式聚合、现金对账
7. **报表系统** — 今日概览、区间销售趋势、月度报表、商品销量 TOP
8. **小票打印** — 80mm 热敏小票（浏览器打印）
9. **聚合支付** — 聚合码支付轮询确认
10. **多门店** — 基于 Vendure Channel 的多租户隔离

### 测试覆盖

17 个测试文件，103 个测试用例覆盖全部核心链路。

---

## 架构说明

### 模块依赖关系

```
┌─────────────────────────────────────────────────────┐
│                    web/ (Vue 3 SPA)                  │
│  LoginView / CashierView / CheckoutView / RefundView │
│  ShiftView / PromotionView / ReportView             │
└──────────────┬──────────────────────────┬───────────┘
               │ GraphQL (admin-api)      │
┌──────────────▼──────────────────────────▼───────────┐
│              server/ (Vendure bootstrap)              │
│  vendure-config.ts  +  index.ts (SPA 静态托管)       │
└──────┬──────────────┬──────────────────┬────────────┘
       │              │                  │
┌──────▼──────┐ ┌─────▼───────┐  ┌──────▼──────────┐
│ vcash-pos-  │ │ vcash-      │  │ 外部 Vendure    │
│ plugin      │ │ offline-    │  │ 插件:           │
│ (收银核心)   │ │ plugin      │  │ cjk-plugin      │
│             │ │ (离线同步)   │  │ member-level-   │
│             │ │              │  │ plugin          │
└─────────────┘ └──────────────┘  └─────────────────┘
```

### 核心模块

| 模块 | 路径 | 职责 |
|---|---|---|
| **vcash-pos-plugin** | `packages/vcash-pos-plugin/` | POS 收银核心服务（11 个 Service + 6 个 Resolver） |
| **vcash-offline-plugin** | `packages/vcash-offline-plugin/` | 离线数据回写与增量拉取（5 个 Service） |
| **server** | `server/` | Vendure 服务入口，配置加载，SPA 静态托管 |
| **web** | `web/` | Vue 3 前端 SPA（8 个 View） |

### 外部依赖

vcash 依赖 `johocn/vendure` 仓库的两个自定义插件，必须与 vcash 并列存放：

```
/workspace/
├── vendure/          # git@github.com:johocn/vendure.git
│   └── packages/
│       ├── cjk-plugin/           # 多语言/本地化
│       └── member-level-plugin/  # 会员等级与积分
└── vcash/            # 当前项目
```

---

## 快速开始（本地开发）

### 前置条件

- Node.js 20+（推荐 20 LTS）
- pnpm 9.12.0
- Git
- PostgreSQL（可选，开发默认使用 SQLite）

### 1. 克隆仓库

```bash
# 克隆 vendure（自定义插件）
git clone https://github.com/johocn/vendure.git ../vendure

# 克隆 vcash
git clone <your-repo-url> .  # 当前目录为 vcash
```

### 2. 安装并构建外部依赖

```bash
# 安装 vendure 子包依赖并构建
cd ../vendure/packages/cjk-plugin
pnpm install && pnpm build

cd ../member-level-plugin
pnpm install && pnpm build

# 回到 vcash 项目
cd ../../vcash
```

### 3. 安装 vcash 依赖

```bash
pnpm install --no-frozen-lockfile
```

> **注意**：Windows 环境下 pnpm install 可能因 tarball 下载阻塞而卡住（显示 `resolved 970, downloaded 0`）。这是已知问题，用 `--no-frozen-lockfile` 可跳过锁文件校验。如果仍卡住，尝试 `pnpm install --no-frozen-lockfile --prefer-offline`。

### 4. 启动开发服务器

```bash
pnpm dev
```

这会启动 Vendure 开发服务器（默认端口 3000，SQLite 数据库，自动建表）。

### 5. 构建前端

新开一个终端：

```bash
pnpm build:web
```

### 6. 访问验证

- **GraphQL Admin API**: `http://localhost:3000/admin-api`
- **前端页面**: `http://localhost:3000/`
- **默认管理员**: `superadmin` / `superadmin`（需在 Vendure Admin UI 中创建）

### 常见开发问题

**pnpm install 锁文件冲突**
```bash
pnpm install --no-frozen-lockfile
```

**sqljs 测试缓存残留**
```bash
# 清理测试缓存（offline-plugin 测试前需执行）
Get-ChildItem -Path __data__ -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse
```

**process.env 未定义**
确认编辑器中环境变量已传递，或直接在终端执行 `$env:NODE_ENV='development'`。

---

## 生产部署

### 部署架构

```
┌─────────┐     ┌──────────┐     ┌──────────────┐
│ 客户端   │────▶│ OpenResty│────▶│ PM2 (fork)   │
│ (浏览器)  │     │ (反代+SSL)│     │ vcash-server │
└─────────┘     └──────────┘     └──────┬───────┘
                                        │
                                ┌───────▼───────┐
                                │  PostgreSQL    │
                                └───────────────┘
```

### 1Panel 环境部署步骤

#### 1. 数据库准备

在 1Panel PostgreSQL 中：
- 创建数据库 `vcash`
- 创建用户 `vcash`，记录密码
- 授权数据库访问

#### 2. 上传代码

将代码上传到服务器（如 `/opt/vcash`），确保 `../vendure` 目录存在且已构建。

#### 3. 构建

```bash
cd /opt/vcash
pnpm install --no-frozen-lockfile
pnpm -r build
```

#### 4. PM2 配置

在 1Panel PM2 管理器中添加项目：
- 项目路径：`/opt/vcash`
- 启动文件：`ecosystem.config.cjs`
- 配置环境变量（见 [配置参考](#配置参考)）

或命令行执行：

```bash
# 设置环境变量
export DB_PASSWORD=your_password
export DB_SYNCHRONIZE=true

# 启动
pm2 start ecosystem.config.cjs
pm2 save
```

#### 5. OpenResty 反代配置

参考 `deploy/nginx-vcash.conf.example`，在 1Panel 网站中创建反代站点：
- 域名：`pos.example.com`
- 反代目标：`127.0.0.1:3000`
- 申请 SSL 证书（Let's Encrypt）

#### 6. 首次部署注意事项

1. **DB_SYNCHRONIZE=true**：首次启动需设为 `true` 自动建表。建表成功后改为 `false` 提升性能与安全。
2. **Vendure 认证**：Vendure bearer token 是 DB 会话（非 JWT），重启不失效。首次部署需通过 `superadmin` 账号创建管理员角色和权限。
3. **数据库迁移**：生产环境 schema 变更需手动处理，synchronize 不适合生产环境长期使用。

---

## POS 操作指南

### 开班

1. 登录系统后在开班页面选择收银终端
2. 填写备用金金额（可选）
3. 点击"开班"按钮
4. 系统进入收银台主页面

### 商品选择与加购

**扫码枪**：直接用扫码枪扫描商品条码，自动添加到购物车。
**搜索**：在搜索框输入商品名称/SKU，从搜索结果中选择。
**手动选择**：点击商品列表中的商品，一键加购。

### 购物车操作

| 操作 | 说明 |
|---|---|
| 调整数量 | 点击 +/- 按钮或直接输入数量 |
| 删除商品 | 点击删除按钮 |
| 会员识别 | 点击"会员"按钮，输入手机号或会员码识别会员，自动应用会员价 |
| 促销自动应用 | 添加商品后系统自动计算最优促销规则（满减/折扣/买赠） |
| 挂单 | 点击"挂单"按钮，当前订单暂存，可继续下一单 |

### 结账

1. 点击"结账"按钮进入结账页面
2. 确认订单信息与金额
3. 选择支付方式：
   - **现金**：直接确认收款
   - **微信/支付宝**：出示收款码或扫码枪扫描顾客付款码
   - **聚合支付**：生成聚合码，顾客扫码支付，系统轮询确认
4. 支付成功后自动打印小票

### 小票打印

支付成功后点击"打印小票"按钮，系统打开浏览器打印窗口。
- 小票格式：80mm 热敏小票（含商品明细、优惠信息、支付方式、终端信息）
- 支持：所有可通过浏览器打印的热敏/针式打印机
- 扩展：预留 WebSerial ESC/POS 直连接口（需硬件支持）

### 挂单/取单

**挂单**：在购物车页面点击"挂单"，当前订单暂存为 hold 状态。
**取单**：在收银台点击"取单"按钮，从挂单列表中选择订单恢复。

### 退款

1. 进入退款页面，输入或选择要退款的订单
2. 选择退款商品和数量
3. 确认退款金额
4. 确认退款，系统自动创建退款订单并冲减库存

### 交班对账

1. 在交班页面查看本班次汇总：
   - 销售总额、订单数
   - 退款额、退款笔数
   - 各支付方式汇总（笔数 + 金额）
   - 现金对账（应交 vs 实交）
2. 填写实交现金金额（可选）
3. 确认差异说明（如有）
4. 点击"关班"完成交班

### 报表查看

进入报表中心可查看：

**今日概览**
- 今日销售额、订单数、客单价
- 退款额、退款笔数
- 各支付方式汇总

**日/区间报表**
- 选择日期范围查看销售趋势
- 折线图展示每日销售额
- 每日明细表格

**月度报表**
- 选择月份查看月度汇总
- 上月环比（金额/订单数变化率）

**商品销量 TOP**
- 按销量或金额排序
- 柱状图展示 TOP 10
- 支持导出 CSV

---

## 功能说明

### 会员体系

vcash 通过 `member-level-plugin` 提供会员能力：

**会员等级**：0-5 级，每个等级可配置不同的折扣率。
**会员价规则**：
- 按作用域：`global`（全店）或 `collection`（指定分类）
- 按会员等级：不同等级享受不同折扣百分比
- 优先级：高优先级规则优先匹配

**积分**：消费可累积积分，可在下次消费使用。

**会员识别**：收银时输入手机号或会员码即可识别，会员价自动应用到购物车。

### 促销规则

支持三种促销类型，互斥最优算法：

| 类型 | 说明 | 配置 |
|---|---|---|
| **满减** | 满额减额，支持多档阶梯 | `tiers: [{threshold, reduction}]` |
| **折扣** | 整单折扣百分比 | `discountPercent: 1-100` + `minAmount` |
| **买赠** | 指定商品达到数量赠送指定商品 | `buyVariantId`, `buyQuantity`, `giftVariantId`, `giftQuantity` |

**互斥最优算法**：
1. 枚举会员价 + 所有 active 规则
2. 计算每个候选的优惠金额（saving）
3. 按 saving 降序 → priority 降序 → ruleId 升序排序
4. 取最优候选应用
5. 会员价和促销规则互斥，只有一个生效

**买赠库存校验**：买赠规则自动检查赠品在指定库存点的可用库存（stockOnHand - stockAllocated ≥ giftQuantity），不足时规则静默跳过。

### 离线同步

支持在断网环境下离线销售，恢复网络后自动同步。

**支持范围**：

| 同步类型 | 说明 |
|---|---|
| 订单同步 | 离线创建的订单同步到服务端 |
| 支付同步 | 独立于订单的支付补录（如聚合支付离线确认） |
| 班次同步 | 离线开班/关班记录同步 |
| 商品增量拉取 | 基于 updatedAt 游标增量拉取商品数据 |
| 会员增量拉取 | 基于 updatedAt 游标增量拉取会员数据 |

**幂等机制**：每个离线记录有唯一 `idempotencyKey`，重复同步返回 `duplicate` 状态。

**LWW 冲突解决**：Last-Write-Wins。如果同步失败记录用更旧的 `clientUpdatedAt` 重试，返回 `CONFLICT`；用更新的 `clientUpdatedAt` 重试则删除旧记录重新处理。

### 报表系统

基于 TypeORM QueryBuilder 实现的多维度数据聚合：

| 报表 | 查询维度 | 数据来源 |
|---|---|---|
| 今日概览 | 当日汇总 | Order + Payment |
| 销售报表 | 选定日期范围按天分组 | Order |
| 月度报表 | 单月汇总 + 上月环比 | Order |
| 商品 TOP | 选定日期范围按商品聚合 | OrderLine + ProductVariant |

金额单位：分（int），前端展示时除以 100。多门店通过 `channelId` 自动过滤。

---

## 配置参考

### 环境变量

| 变量 | 说明 | 默认值 | 适用环境 |
|---|---|---|---|
| `NODE_ENV` | 运行模式 | `development` | 全部 |
| `PORT` | 监听端口 | `3000` | 全部 |
| `DB_TYPE` | 数据库类型 | `better-sqlite3` | 全部 |
| `DB_HOST` | PostgreSQL 主机 | `localhost` | 生产 |
| `DB_PORT` | PostgreSQL 端口 | `5432` | 生产 |
| `DB_USERNAME` | PostgreSQL 用户 | `vcash` | 生产 |
| `DB_PASSWORD` | PostgreSQL 密码 | `vcash` | 生产 |
| `DB_DATABASE` | PostgreSQL 数据库 | `vcash` | 生产 |
| `DB_SYNCHRONIZE` | 自动建表 | `false` | 生产 |
| `LOG_LEVEL` | 日志级别（Info/Warn/Error） | `Info`(dev) / `Warn`(prod) | 全部 |
| `WEB_DIST_DIR` | 前端构建产物目录 | `./web/dist` | 生产 |
| `ASSET_DIR` | 资源文件目录 | `./server/assets` | 生产 |
| `EMAIL_OUTPUT_DIR` | 邮件输出目录 | `./server/email-output` | 生产 |

### PM2 配置（ecosystem.config.cjs）

关键配置项：

| 配置项 | 值 | 说明 |
|---|---|---|
| `name` | `vcash-server` | PM2 进程名 |
| `script` | `server/dist/index.js` | 入口文件 |
| `instances` | `1` | 单实例（fork 模式） |
| `exec_mode` | `fork` | 不支持 cluster（Vendure 状态化） |
| `max_memory_restart` | `1G` | 超过 1G 自动重启 |
| `out_file` | `./logs/vcash-out.log` | 标准输出日志 |
| `error_file` | `./logs/vcash-error.log` | 错误日志 |

### Nginx / OpenResty 配置

参考 `deploy/nginx-vcash.conf.example`，关键配置：

```nginx
# 反代到 Vendure
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # WebSocket 支持（GraphQL subscriptions）
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    # 超时（支付确认等耗时操作）
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

---

## FAQ

### 开发环境

**Q: pnpm install 卡在 "resolved 970, downloaded 0"？**
A: Windows 下 tarball 下载可能被阻塞。用 `pnpm install --no-frozen-lockfile` 跳过锁文件校验。如果仍卡住，尝试 `pnpm install --no-frozen-lockfile --prefer-offline`。

**Q: 测试报错 "no such column" 或缓存相关？**
A: sqljs 测试可能残留缓存。清理 `__data__` 目录后重试：
```bash
Get-ChildItem -Path __data__ -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -Recurse
```

**Q: 修改 plugin 代码后未生效？**
A: 开发模式下 Vendure 会自动编译 `packages/*/src/*.ts` 到 dist，重新启动 Vendure 即可。无需手动 `npm run build`。

**Q: "Parameter 'req' implicitly has an 'any' type" 错误？**
A: 确认安装了 `@types/express`：`pnpm --filter server add -D @types/express`。

### 生产环境

**Q: 首次启动后数据库没有表？**
A: 确认 `DB_SYNCHRONIZE=true` 已设置。Vendure 生产环境默认 `synchronize: false`，需显式开启。

**Q: PM2 如何查看日志？**
A: `pm2 logs vcash-server` 或查看 `logs/vcash-out.log` 和 `logs/vcash-error.log`。

**Q: 部署后前端页面空白（404）？**
A: 确认已执行 `pnpm build:web`，且 `WEB_DIST_DIR` 指向正确的构建产物目录。

**Q: SSL 证书如何续期？**
A: 1Panel 自动管理 Let's Encrypt 证书续期。如果使用其他证书提供方，参考 nginx 配置中 `ssl_certificate` 路径。

### 业务操作

**Q: 会员识别失败？**
A: 确认会员已在系统中注册（通过 Vendure Admin 或 member-level-plugin）。手机号/会员码需精确匹配。

**Q: 促销规则未生效？**
A: 检查：1) 规则是否已启用（active=true）；2) 规则时间范围是否覆盖当前时间；3) 规则作用域是否匹配（global 或指定分类）；4) 买赠规则检查赠品库存是否充足。

**Q: 离线同步冲突？**
A: 确认离线终端的系统时间与服务器同步。如果 `clientUpdatedAt` 比服务端记录的旧，会返回 `CONFLICT`。需在客户端更新 `clientUpdatedAt` 后重试。

**Q: 聚合支付一直显示 "支付中"？**
A: 确认聚合支付服务已配置且网络可达。前端默认每 2 秒轮询一次支付状态，超时需重新发起支付。

---

## License

Internal use only.