# 促销规则 collection 集合作用域补全（Promotion Collection Scope）设计

- 创建日期：2026-09-20
- 状态：Spec
- 目标仓库：vcash（Vendure 多租户多仓库 POS 收银系统）

---

## 1. 任务背景与目标

### 1.1 背景

促销规则实体与 CRUD 已支持 `scope`（`global`/`collection`）与 `collectionId` 字段，且 `PromotionRuleService.validateInput` 强制 `scope=collection` 时必须传 `collectionId`。但存在两处缺口：

1. **后端引擎不生效**：`promotion-engine.service.ts` 的候选计算（`calculateFullReductionCandidate` / `calculateDiscountCandidate` / `calculateBuyGiftCandidate`）**完全忽略 scope/collectionId**，一律在整单 subTotal 上计算、全单生效。即 collection 作用域「存而不检」，配置了也当全局用。
2. **前端不可配**：`PromotionView.vue` 的「作用域」radio 中 `指定分类(collection)` 被 `disabled`，并提示「当前版本仅支持全局作用域」。

### 1.2 目标

1. 后端促销引擎真正按 `scope=collection` + `collectionId` 过滤：满减/折扣只在属于该集合的行上算基数与生效，买赠只在集合内商品上命中。
2. 前端促销管理放开 collection 选项，提供集合选择器，创建/编辑规则可绑定集合。
3. 集合作用域的可视化（表格「规则条件」显示为「指定分类：<集合名>」）。

### 1.3 非目标（YAGNI）

- 不做集合树/折叠交互，使用 Vendure 集合列表下拉即可。
- 不做「集合内再限指定单品」的复合作用域。
- 不改动 `global` 作用域的既有行为。

---

## 2. 整体设计

### 2.1 集合成员解析（核心）

Vendure 将集合成员落表在 `product_collection`（`collectionId` × `productId`）。用原生 Connection 查询当前 channel 下该集合的 productId 集合：

```
SELECT DISTINCT pc."productId"
FROM product_collection pc
JOIN collection c ON c.id = pc."collectionId"
WHERE pc."collectionId" = :collectionId AND c.channelId = :channelId
```

- 返回 `Set<string>`（productId 用字符串，规避 Vendure ID 类型）。
- 兼容 SQLite/Postgres：列名 `productId`/`collectionId`/`channelId`，大小写按驱动处理（提供大小写不敏感的查法参考）。若表/列不存在（schema 未同步），返回空集合 → collection 规则不命中，不抛错。
- 该方法在 `PromotionRuleService` 新增 `resolveCollectionProductIds(ctx, collectionId): Promise<Set<string>>`，并缓存于单次 `calculateBest` 调用内。

### 2.2 后端：引擎匹配按集合过滤

改造 `promotion-engine.service.ts`（不动排序与互斥原则）：

**新增私有方法 `scopedLines(order, productIds | null)`**：
- `productIds === null` → 返回全部非 gift 行（global 语义，兼容现状）。
- 否则只返回 `productId ∈ productIds` 且非 gift 的行。

**满减 `calculateFullReductionCandidate(rule, order)`**：
- `scope==='collection'` 时先解析集合 productIds，取 `scopedLines` 的 subTotal（用 `initialListPrice` × 数量），在**该基数**上找最高满足的 tier。
- 命中后原样返回 candidate（折扣金额仍以 tier.reduction 记）——保持与全单一致的「优惠金额=档位减免」语义，仅基数/命中范围收敛到集合。

**折扣 `calculateDiscountCandidate(rule, order)`**：
- 用 `scopedLines` 的 subTotal 计算 `discountMoney = floor(scopedSubTotal*(100-dp)/100)`；`minOrderValue` 同样与 scopedSubTotal 比较。
- saving = discountMoney（作用于集合内行，集合外行不折）。

**买赠 `calculateBuyGiftCandidate(ctx, rule, order, stockLocationId)`**：
- 命中判定：`buyVariantId` 对应商品须 ∈ 集合（集合规则时），且在 `scopedLines` 中累计数量 ≥ buyQuantity。
- 库存/价格读取逻辑不变。

**入参签名**：`calculateRuleCandidate` 以及各 `calculate*Candidate` 增加 `collectionInfo`（`{ productIds: Set<string> } | null`）形参，由 `calculateBest` 统一在需要时一次性解析（global 规则不解析集合，避免多余查询）。

### 2.3 后端：GraphQL

schema 已有 `scope`/`collectionId` 字段与 `CreatePromotionRuleInput`/`UpdatePromotionRuleInput`，无需扩展。
新增只读 Query 供前端集合选择器用：`promotionCollections: [PromotionCollection!]!`（复用 Vendure Collection 数据，返回 `{ id, name }`，仅限当前 channel）。在 `plugin.ts` adminSchema 增加类型与查询，`admin-promotion.resolver.ts` 新增 resolver。

### 2.4 前端：PromotionView 放开 collection + 集合选择

`web/src/views/PromotionView.vue`：

- 「作用域」radio 启用 `collection`，删除「当前版本仅支持全局作用域」提示。
- `form.scope==='collection'` 时显示集合选择器（`el-select`，数据来自 `promotionCollections` 查询，值即集合 ID），绑定 `form.collectionId`。
- 新增/编辑时：`buildInput()` 在 `scope==='collection'` 时带 `collectionId`，否则不带。
- 编辑回填：`openEdit` 时若 `rule.scope==='collection'` 回填 `form.collectionId = rule.collectionId`，并在表格「规则条件」列显示「指定分类：<集合名>」（解析自下拉数据映射）。
- 前端预校验：`scope==='collection'` 时必须选集合，否则阻断提交。

---

## 3. 边界与口径

- `scope=collection` 但集合结果为空：规则不命中（saving≤0 → 不成为候选），静默跳过，不抛错。
- 集合规则与会员价仍互斥，`saving` 对比用集合内基数算出的金额。
- 买赠赠品行 `isGift` 不计入任何作用域的 subTotal（沿用 `computeEffectiveSubTotal` 排除逻辑）。

---

## 4. 测试

对 `promotion-engine.service.ts` 写单元测试：

- collection 满减：命中集合内 high-tier，集合外行不计入基数。
- collection 折扣：仅集合内行打折，saving 按 scopedSubTotal 计算；集合结果为空不命中。
- collection 买赠：buyVariant 在集合内命中；buyVariant 在集合外不命中。
- global 规则回归：不传 collectionInfo 时行为与现状一致。

前端：`pnpm build:web` 通过；`PromotionView` 可创建/编辑/回填 collection 规则。

---

## 5. 验收标准

1. 建立 collection 集合 C（含商品 A、B），建满减「满300减30（指定分类：C）」：
   - 购物车仅含 A+B（subTotal≥300）→ 命中减 30；购物车含 C 外商品拉到 subTotal 但不达集合内基数 → 不命中。
2. 引擎对 global 规则行为与改造前完全一致（回归）。
3. 前端可选取集合创建/编辑规则，无 console 错误。
4. 手机视口（390×844, dpr=2）截图：促销管理含集合作用域规则的列表与编辑表单。
5. `pnpm -r build`（后端）与 `pnpm build:web`（前端）通过。