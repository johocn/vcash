# 实现计划：促销规则 collection 集合作用域

> 设计规格：`docs/superpowers/specs/2026-09-20-promotion-collection-scope-design.md`

## 目标
让 `scope=collection` 真正生效：促销引擎按集合过滤匹配基数/命中，前端放开集合选择器。global 行为保持回归一致。

## 前置条件
- vcash 可 `pnpm -r build`。
- 前端 `pnpm build:web` 通过。

## 实施步骤

### Step 1 — 后端 PromotionRuleService 集合成员解析
文件：`packages/vcash-pos-plugin/src/services/promotion-rule.service.ts`
1. 新增 `async resolveCollectionProductIds(ctx, collectionId): Promise<Set<string>>`：
   - 原生查询 `product_collection`（join `collection` 限 channelId），返回 productId 集合（字符串）。
   - 表/列不存在或集合为空→返回空 Set，不抛错。
2. 自检：SQLite/Postgres 列名大小写兼容（大小写不敏感匹配）。

### Step 2 — 后端引擎按集合过滤
文件：`packages/vcash-pos-plugin/src/services/promotion-engine.service.ts`
1. `calculateBest`：遍历规则时，仅 `scope==='collection'` 的规则调用 `resolveCollectionProductIds`（一次性传 `collectionInfo`），global 传 null 不解析。
2. 新增私有 `scopedLines(order, productIds|null)`：null→全部非 gift 行；否则仅 `productId ∈ productIds` 非 gift 行。
3. 改三个候选方法以接受 `collectionInfo`：
   - `calculateFullReductionCandidate`：subTotal 用 scopedLines 基数，tier 在此基数上匹配。
   - `calculateDiscountCandidate`：subTotal/minOrderValue 用 scopedLines 基数，saving 据此计算。
   - `calculateBuyGiftCandidate`：买赠命中只在 scopedLines 判定 `buyVariantId` 数量；集合内需 buyVariant 在集合内。
   - `computeEffectiveSubTotal` 增加可选 `productIds` 形参或抽取 scoped 版本。
4. `calculateRuleCandidate` 透传 `collectionInfo`。
5. 自检：global 走 null 分支，行为与改造前完全一致。

### Step 3 — 后端 Schema：promotionCollections 查询
文件：`packages/vcash-pos-plugin/src/plugin.ts`、`resolvers/admin-promotion.resolver.ts`
1. adminSchema 新增 `type PromotionCollection { id: ID!, name: String! }` + `extend type Query { promotionCollections(channelId: ID): [PromotionCollection!]! }`。
2. resolver 用 Vendure CollectionService 按当前 channel 返回 `{id, name}` 列表。

### Step 4 — 前端 PromotionView 放开 collection + 集合选择
文件：`web/src/views/PromotionView.vue`
1. 新增 `PROMOTION_COLLECTIONS` 查询与 `collections` 状态。
2. 「作用域」radio 启用 collection，删「仅支持全局」提示。
3. `scope==='collection'` 显示 `el-select` 集合选择（值=集合 ID），绑定 `form.collectionId`；新增校验必选。
4. `buildInput()`：collection 时带 `collectionId`。
5. `openEdit` 回填 `collectionId`；表格「规则条件」对 collection 规则显示「指定分类：<集合名>」（下拉映射）。
6. 自检：可创建/编辑/回填/删除 collection 规则，无 console 错误。

### Step 5 — 单元测试（引擎）
书写引擎 collection 作用域用例：
- 满减：集合内基数命中 / 集合外拉总不命中。
- 折扣：仅集合内折、saving 按集合基数。
- 买赠：集合内命中 / 集合外不命中。
- global 回归：无 collectionInfo 行为不变。
自检：`pnpm -r test` 相关用例通过。

### Step 6 — 构建与验证
1. `pnpm -r build` 后端通过。
2. `pnpm build:web` 前端通过。
3. 手机视口（390×844, dpr=2）截图「促销管理 → 集合规则」列表与编辑表单存档。

## 验收
见设计文档 §5。真实数据验证：集合 C(商品 A、B)，满减「满300减30 指定分类 C」——仅 A+B 达基数命中，混入 C 外商品不命中。

## 清单
- [ ] resolveCollectionProductIds
- [ ] 引擎 scoped baseline 与三个规则过滤
- [ ] promotionCollections resolver/schema
- [ ] 前端集合选择器
- [ ] 引擎单元测试
- [ ] 双端构建通过
- [ ] 手机截图