<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import { formatMoney } from '@/utils/format';

// ===== GraphQL =====
const PROMOTION_RULES = gql`
  query PromotionRules {
    promotionRules {
      id type name description scope collectionId priority active
      startTime endTime conditions actions createdAt updatedAt
    }
  }
`;
const CREATE_RULE = gql`
  mutation CreatePromotionRule($input: CreatePromotionRuleInput!) {
    createPromotionRule(input: $input) { id type name priority active }
  }
`;
const UPDATE_RULE = gql`
  mutation UpdatePromotionRule($input: UpdatePromotionRuleInput!) {
    updatePromotionRule(input: $input) { id priority active }
  }
`;
const DELETE_RULE = gql`
  mutation DeletePromotionRule($id: ID!) { deletePromotionRule(id: $id) }
`;

// ===== 类型 =====
type PromotionType = 'fullReduction' | 'discount' | 'buyGift';
type PromotionScope = 'global' | 'collection';

interface Tier {
  threshold: number;
  reduction: number;
}

interface PromotionRule {
  id: string;
  type: PromotionType;
  name: string;
  description: string | null;
  scope: PromotionScope;
  collectionId: number | null;
  priority: number;
  active: boolean;
  startTime: string | null;
  endTime: string | null;
  conditions: any;
  actions: any;
  createdAt: string;
  updatedAt: string;
}

interface FormState {
  id?: string;
  type: PromotionType;
  name: string;
  description: string;
  scope: PromotionScope;
  priority: number;
  active: boolean;
  startTime: string;
  endTime: string;
  // fullReduction
  tiers: Tier[];
  // discount
  discountPercent: number;
  minOrderValue: number;
  // buyGift
  buyVariantId: number;
  buyQuantity: number;
  giftVariantId: number;
  giftQuantity: number;
}

// ===== 状态 =====
const router = useRouter();
const rules = ref<PromotionRule[]>([]);
const loading = ref(false);
const dialogVisible = ref(false);
const dialogMode = ref<'create' | 'edit'>('create');
const submitting = ref(false);
const formRef = ref<FormInstance>();

const defaultForm = (): FormState => ({
  type: 'fullReduction',
  name: '',
  description: '',
  scope: 'global',
  priority: 10,
  active: true,
  startTime: '',
  endTime: '',
  tiers: [{ threshold: 0, reduction: 0 }],
  discountPercent: 95,
  minOrderValue: 0,
  buyVariantId: 0,
  buyQuantity: 1,
  giftVariantId: 0,
  giftQuantity: 1,
});

const form = reactive<FormState>(defaultForm());

const formRules: FormRules = {
  name: [{ required: true, message: '请输入规则名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择规则类型', trigger: 'change' }],
  priority: [{ required: true, message: '请输入优先级', trigger: 'blur' }],
};

// ===== 计算属性 =====
const typeLabel = (t: PromotionType): string => {
  switch (t) {
    case 'fullReduction': return '满减';
    case 'discount': return '整单折扣';
    case 'buyGift': return '买赠';
  }
};

const typeTagType = (t: PromotionType): '' | 'success' | 'warning' | 'info' => {
  switch (t) {
    case 'fullReduction': return 'warning';
    case 'discount': return 'success';
    case 'buyGift': return 'info';
  }
};

const scopeLabel = (s: PromotionScope): string => (s === 'global' ? '全局' : '指定分类');

const formatTime = (t: string | null): string => {
  if (!t) return '-';
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
};

const formatConditions = (rule: PromotionRule): string => {
  try {
    if (rule.type === 'fullReduction') {
      const tiers: Tier[] = rule.conditions?.tiers ?? [];
      return tiers.map((t) => `满${formatMoney(t.threshold)}减${formatMoney(t.reduction)}`).join('；');
    }
    if (rule.type === 'discount') {
      const dp = rule.actions?.discountPercent ?? 100;
      const min = rule.conditions?.minOrderValue ?? 0;
      return min > 0 ? `${dp}折（满${formatMoney(min)}）` : `${dp}折`;
    }
    if (rule.type === 'buyGift') {
      const buyQty = rule.conditions?.buyQuantity ?? 0;
      const giftQty = rule.actions?.giftQuantity ?? 0;
      return `买${buyQty}送${giftQty}`;
    }
  } catch {
    return '-';
  }
  return '-';
};

// ===== 加载 =====
async function loadRules() {
  loading.value = true;
  try {
    const { data, errors } = await apolloClient.query({ query: PROMOTION_RULES, fetchPolicy: 'network-only' });
    if (errors?.length && !data) throw new Error(errors[0].message);
    rules.value = (data?.promotionRules ?? []) as PromotionRule[];
  } catch (e) {
    ElMessage.error('加载规则失败：' + (e instanceof Error ? e.message : ''));
  } finally {
    loading.value = false;
  }
}

// ===== 新建/编辑 =====
function openCreate() {
  Object.assign(form, defaultForm());
  dialogMode.value = 'create';
  dialogVisible.value = true;
}

function openEdit(rule: PromotionRule) {
  Object.assign(form, defaultForm());
  form.id = rule.id;
  form.type = rule.type;
  form.name = rule.name;
  form.description = rule.description ?? '';
  form.scope = rule.scope;
  form.priority = rule.priority;
  form.active = rule.active;
  form.startTime = rule.startTime ?? '';
  form.endTime = rule.endTime ?? '';
  if (rule.type === 'fullReduction') {
    form.tiers = (rule.conditions?.tiers ?? [{ threshold: 0, reduction: 0 }]).map((t: Tier) => ({ ...t }));
  } else if (rule.type === 'discount') {
    form.discountPercent = rule.actions?.discountPercent ?? 95;
    form.minOrderValue = rule.conditions?.minOrderValue ?? 0;
  } else if (rule.type === 'buyGift') {
    form.buyVariantId = rule.conditions?.buyVariantId ?? 0;
    form.buyQuantity = rule.conditions?.buyQuantity ?? 1;
    form.giftVariantId = rule.actions?.giftVariantId ?? 0;
    form.giftQuantity = rule.actions?.giftQuantity ?? 1;
  }
  dialogMode.value = 'edit';
  dialogVisible.value = true;
}

function addTier() {
  form.tiers.push({ threshold: 0, reduction: 0 });
}

function removeTier(idx: number) {
  if (form.tiers.length <= 1) {
    ElMessage.warning('至少保留一档');
    return;
  }
  form.tiers.splice(idx, 1);
}

function buildInput(): any {
  const base: any = {
    type: form.type,
    name: form.name.trim(),
    description: form.description.trim() || null,
    scope: form.scope,
    priority: form.priority,
    active: form.active,
    startTime: form.startTime ? new Date(form.startTime).toISOString() : null,
    endTime: form.endTime ? new Date(form.endTime).toISOString() : null,
  };
  if (form.type === 'fullReduction') {
    base.conditions = { tiers: form.tiers.map((t) => ({ threshold: Number(t.threshold), reduction: Number(t.reduction) })) };
    base.actions = null;
  } else if (form.type === 'discount') {
    base.conditions = { minOrderValue: Number(form.minOrderValue) };
    base.actions = { discountPercent: Number(form.discountPercent) };
  } else if (form.type === 'buyGift') {
    base.conditions = {
      buyVariantId: Number(form.buyVariantId),
      buyQuantity: Number(form.buyQuantity),
    };
    base.actions = {
      giftVariantId: Number(form.giftVariantId),
      giftQuantity: Number(form.giftQuantity),
    };
  }
  return base;
}

async function handleSubmit() {
  if (!formRef.value) return;
  try {
    await formRef.value.validate();
  } catch {
    return;
  }
  // 前端预校验（与后端 validateInput 一致）
  if (form.type === 'fullReduction') {
    const tiers = form.tiers;
    for (let i = 0; i < tiers.length; i++) {
      if (tiers[i].threshold < 0 || tiers[i].reduction < 0 || tiers[i].reduction > tiers[i].threshold) {
        ElMessage.error(`第 ${i + 1} 档：threshold/reduction 非负且 reduction ≤ threshold`);
        return;
      }
      if (i > 0 && tiers[i].threshold <= tiers[i - 1].threshold) {
        ElMessage.error('tier.threshold 必须严格递增');
        return;
      }
    }
  } else if (form.type === 'discount') {
    if (form.discountPercent < 1 || form.discountPercent > 100) {
      ElMessage.error('discountPercent 必须 1-100');
      return;
    }
  } else if (form.type === 'buyGift') {
    if (form.buyVariantId <= 0 || form.giftVariantId <= 0 || form.buyQuantity < 1 || form.giftQuantity < 1) {
      ElMessage.error('买赠：buyVariantId/giftVariantId/buyQuantity/giftQuantity 必须为正数');
      return;
    }
  }

  submitting.value = true;
  try {
    if (dialogMode.value === 'create') {
      const { data, errors } = await apolloClient.mutate({
        mutation: CREATE_RULE,
        variables: { input: buildInput() },
      });
      if (errors?.length) throw new Error(errors[0].message);
      ElMessage.success('规则已创建');
    } else {
      const input: any = { ...buildInput(), id: form.id };
      const { data, errors } = await apolloClient.mutate({
        mutation: UPDATE_RULE,
        variables: { input },
      });
      if (errors?.length) throw new Error(errors[0].message);
      ElMessage.success('规则已更新');
    }
    dialogVisible.value = false;
    await loadRules();
  } catch (e) {
    ElMessage.error('保存失败：' + (e instanceof Error ? e.message : ''));
  } finally {
    submitting.value = false;
  }
}

// ===== 删除 =====
async function handleDelete(rule: PromotionRule) {
  try {
    await ElMessageBox.confirm(`确认删除规则「${rule.name}」？`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    });
  } catch {
    return;
  }
  try {
    const { errors } = await apolloClient.mutate({
      mutation: DELETE_RULE,
      variables: { id: rule.id },
    });
    if (errors?.length) throw new Error(errors[0].message);
    ElMessage.success('已删除');
    await loadRules();
  } catch (e) {
    ElMessage.error('删除失败：' + (e instanceof Error ? e.message : ''));
  }
}

// ===== 启用/停用 =====
async function handleToggleActive(rule: PromotionRule) {
  try {
    const { errors } = await apolloClient.mutate({
      mutation: UPDATE_RULE,
      variables: { input: { id: rule.id, active: !rule.active } },
    });
    if (errors?.length) throw new Error(errors[0].message);
    ElMessage.success(rule.active ? '已停用' : '已启用');
    await loadRules();
  } catch (e) {
    ElMessage.error('切换失败：' + (e instanceof Error ? e.message : ''));
  }
}

function handleBack() {
  router.push('/cashier');
}

onMounted(() => {
  loadRules();
});
</script>

<template>
  <div class="promotion-view">
    <header class="top-bar">
      <el-button text @click="handleBack">← 返回收银台</el-button>
      <span class="title">促销规则管理</span>
      <el-button type="primary" @click="openCreate">+ 新建规则</el-button>
    </header>

    <main class="content" v-loading="loading">
      <el-table :data="rules" size="small" empty-text="暂无促销规则">
        <el-table-column label="名称" min-width="160">
          <template #default="{ row }">
            <span class="rule-name">{{ row.name }}</span>
            <el-tag size="small" :type="typeTagType(row.type)" style="margin-left: 6px">
              {{ typeLabel(row.type) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="规则条件" min-width="200">
          <template #default="{ row }">{{ formatConditions(row) }}</template>
        </el-table-column>
        <el-table-column label="优先级" width="80" prop="priority" />
        <el-table-column label="状态" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.active ? 'success' : 'info'">
              {{ row.active ? '启用' : '停用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="生效时段" min-width="180">
          <template #default="{ row }">
            <div class="time-cell">
              <div>起：{{ formatTime(row.startTime) }}</div>
              <div>止：{{ formatTime(row.endTime) }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <el-button size="small" text @click="handleToggleActive(row)">
              {{ row.active ? '停用' : '启用' }}
            </el-button>
            <el-button size="small" text type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" text type="danger" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </main>

    <!-- 新建/编辑对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogMode === 'create' ? '新建促销规则' : '编辑促销规则'"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="110px" size="default">
        <el-form-item label="规则类型" prop="type">
          <el-radio-group v-model="form.type" :disabled="dialogMode === 'edit'">
            <el-radio-button value="fullReduction">满减</el-radio-button>
            <el-radio-button value="discount">整单折扣</el-radio-button>
            <el-radio-button value="buyGift">买赠</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="规则名称" prop="name">
          <el-input v-model="form.name" placeholder="如：满200减30" maxlength="50" show-word-limit />
        </el-form-item>

        <el-form-item label="描述">
          <el-input v-model="form.description" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>

        <el-form-item label="作用域">
          <el-radio-group v-model="form.scope">
            <el-radio value="global">全局</el-radio>
            <el-radio value="collection" disabled>指定分类</el-radio>
          </el-radio-group>
          <div class="hint">当前版本仅支持全局作用域</div>
        </el-form-item>

        <el-form-item label="优先级" prop="priority">
          <el-input-number v-model="form.priority" :min="0" :max="999" />
          <div class="hint">数字大者优先；同 saving 取 priority 大者</div>
        </el-form-item>

        <el-form-item label="启用状态">
          <el-switch v-model="form.active" />
        </el-form-item>

        <el-form-item label="生效时段">
          <el-date-picker
            v-model="form.startTime"
            type="datetime"
            placeholder="开始时间（可空）"
            format="YYYY-MM-DD HH:mm"
            value-format="YYYY-MM-DDTHH:mm:ss"
            style="width: 200px"
          />
          <span style="margin: 0 8px">至</span>
          <el-date-picker
            v-model="form.endTime"
            type="datetime"
            placeholder="结束时间（可空）"
            format="YYYY-MM-DD HH:mm"
            value-format="YYYY-MM-DDTHH:mm:ss"
            style="width: 200px"
          />
        </el-form-item>

        <el-divider content-position="left">规则参数</el-divider>

        <!-- 满减 -->
        <template v-if="form.type === 'fullReduction'">
          <div v-for="(tier, idx) in form.tiers" :key="idx" class="tier-row">
            <el-form-item :label="`第 ${idx + 1} 档`">
              <span class="tier-label">满</span>
              <el-input-number v-model="tier.threshold" :min="0" :step="100" controls-position="right" />
              <span class="tier-label">减</span>
              <el-input-number v-model="tier.reduction" :min="0" :step="10" controls-position="right" />
              <el-button text type="danger" @click="removeTier(idx)">删除</el-button>
            </el-form-item>
          </div>
          <el-form-item>
            <el-button text type="primary" @click="addTier">+ 添加档位</el-button>
          </el-form-item>
        </template>

        <!-- 折扣 -->
        <template v-else-if="form.type === 'discount'">
          <el-form-item label="折扣百分比">
            <el-input-number v-model="form.discountPercent" :min="1" :max="100" :step="5" />
            <span class="tier-label">（80 表示 8 折）</span>
          </el-form-item>
          <el-form-item label="最低订单金额">
            <el-input-number v-model="form.minOrderValue" :min="0" :step="100" />
            <span class="tier-label">分（0=不限）</span>
          </el-form-item>
        </template>

        <!-- 买赠 -->
        <template v-else-if="form.type === 'buyGift'">
          <el-form-item label="购买商品 ID">
            <el-input-number v-model="form.buyVariantId" :min="1" controls-position="right" />
            <span class="tier-label">ProductVariant 数字 ID</span>
          </el-form-item>
          <el-form-item label="购买数量">
            <el-input-number v-model="form.buyQuantity" :min="1" />
          </el-form-item>
          <el-form-item label="赠品 ID">
            <el-input-number v-model="form.giftVariantId" :min="1" controls-position="right" />
            <span class="tier-label">ProductVariant 数字 ID</span>
          </el-form-item>
          <el-form-item label="赠品数量">
            <el-input-number v-model="form.giftQuantity" :min="1" />
          </el-form-item>
        </template>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.promotion-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f0f2f5;
  overflow: hidden;
}
.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  background: #fff;
  border-bottom: 1px solid #ebeef5;
  flex-shrink: 0;
}
.top-bar .title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}
.content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.rule-name {
  font-weight: 500;
  color: #303133;
}
.time-cell {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
.hint {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
.tier-row {
  margin-bottom: 4px;
}
.tier-label {
  margin: 0 6px;
  color: #606266;
  font-size: 13px;
}
</style>
