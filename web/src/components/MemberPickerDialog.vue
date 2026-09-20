<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import type { MemberInfo } from '@/stores/cart';

const FIND_MEMBER_BY_PHONE = gql`
  query FindMemberByPhone($phoneNumber: String!) {
    findMemberByPhone(phoneNumber: $phoneNumber) {
      customerId
      firstName
      lastName
      emailAddress
      phoneNumber
      memberLevel
      growthValue
      points
    }
  }
`;

const FIND_MEMBER_BY_CODE = gql`
  query FindMemberByCode($code: String!) {
    findMemberByCode(code: $code) {
      customerId
      firstName
      lastName
      emailAddress
      phoneNumber
      memberLevel
      growthValue
      points
    }
  }
`;

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'bound', member: MemberInfo): void;
}>();

const keyword = ref('');
const loading = ref(false);
const result = ref<MemberInfo | null>(null);

const isCode = computed(() => /^\d+$/.test(keyword.value.trim()));
const placeholder = computed(() =>
  isCode.value ? '卡号（纯数字）' : '手机号（11位数字）',
);

async function search() {
  const kw = keyword.value.trim();
  if (!kw) {
    ElMessage.warning('请输入手机号或卡号');
    return;
  }
  loading.value = true;
  result.value = null;
  try {
    const query = isCode.value ? FIND_MEMBER_BY_CODE : FIND_MEMBER_BY_PHONE;
    const variables = isCode.value ? { code: kw } : { phoneNumber: kw };
    const { data, errors } = await apolloClient.query({
      query,
      variables,
      fetchPolicy: 'network-only',
    });
    if (errors?.length) throw new Error(errors[0].message);
    result.value = (data?.findMemberByPhone ?? data?.findMemberByCode ?? null) as MemberInfo | null;
    if (!result.value) {
      ElMessage.warning('未查询到匹配会员');
    }
  } catch (e) {
    ElMessage.error('查询失败：' + (e instanceof Error ? e.message : ''));
  } finally {
    loading.value = false;
  }
}

function handleEnter() {
  search();
}

function handleConfirm() {
  if (!result.value) {
    ElMessage.warning('请先查询并选择会员');
    return;
  }
  emit('bound', result.value);
  emit('update:visible', false);
  reset();
}

function handleCancel() {
  emit('update:visible', false);
  reset();
}

function reset() {
  keyword.value = '';
  result.value = null;
}

function levelLabel(level: number): string {
  const labels: Record<number, string> = {
    1: 'LV1 普通会员',
    2: 'LV2 银卡会员',
    3: 'LV3 金卡会员',
    4: 'LV4 铂金会员',
    5: 'LV5 钻石会员',
  };
  return labels[level] ?? `LV${level}`;
}

function formatCode(customerId: string): string {
  // 卡号展示为 #00001 格式（取 id 末段数字，左补零至 5 位）
  const numStr = String(customerId).split('_').pop() ?? String(customerId);
  const num = parseInt(numStr, 10);
  return Number.isFinite(num) ? '#' + String(num).padStart(5, '0') : customerId;
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="会员识别"
    width="480px"
    @update:model-value="handleCancel"
    @close="reset"
  >
    <div class="member-picker">
      <!-- 输入区 -->
      <div class="search-bar">
        <el-input
          v-model="keyword"
          :placeholder="placeholder"
          clearable
          @keyup.enter="handleEnter"
        />
        <el-button type="primary" :loading="loading" @click="search">
          查询
        </el-button>
      </div>

      <!-- 结果区 -->
      <div v-loading="loading" class="result-area">
        <div v-if="!loading && !result" class="empty-state">
          请输入手机号或卡号查询会员
        </div>
        <div v-else-if="result" class="member-card">
          <div class="member-header">
            <span class="member-code">{{ formatCode(result.customerId) }}</span>
            <el-tag size="small" type="warning">{{ levelLabel(result.memberLevel) }}</el-tag>
          </div>
          <div class="member-name">
            {{ result.lastName }}{{ result.firstName }}
          </div>
          <div class="member-meta">
            <span class="meta-item">手机：{{ result.phoneNumber ?? '—' }}</span>
            <span class="meta-item">积分：{{ result.points }}</span>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="handleCancel">取消</el-button>
      <el-button type="primary" :disabled="!result" @click="handleConfirm">
        确认绑定
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.member-picker {
  min-height: 160px;
}
.search-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.result-area {
  min-height: 100px;
}
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100px;
  color: #909399;
  font-size: 13px;
}
.member-card {
  padding: 12px 16px;
  border: 1px solid #ebeef5;
  border-radius: 4px;
  background: #fafafa;
}
.member-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.member-code {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
  letter-spacing: 0.5px;
}
.member-name {
  font-size: 14px;
  color: #303133;
  margin-bottom: 6px;
}
.member-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #909399;
}
.meta-item {
  white-space: nowrap;
}
</style>
