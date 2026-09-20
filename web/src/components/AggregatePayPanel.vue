<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import {
  useAggregatePayPolling,
  type PolledPayment,
} from '@/composables/useAggregatePayPolling';

const emit = defineEmits<{
  (e: 'success', payment: PolledPayment): void;
  (e: 'fail', reason: string): void;
}>();

const CREATE_AGGREGATE_PAY = gql`
  mutation CreateAggregatePay($aggregatePayCode: String!) {
    createAggregatePay(input: { aggregatePayCode: $aggregatePayCode }) {
      id
      amount
      state
      method
      customFields {
        aggregatePayCode
        aggregatePayStatus
      }
    }
  }
`;

const FAIL_AGGREGATE_PAY = gql`
  mutation FailAggregatePay($paymentId: ID!) {
    failAggregatePay(paymentId: $paymentId) {
      id
      state
    }
  }
`;

const COUNTDOWN_SECONDS = 300; // 5 分钟
const paymentId = ref<string | null>(null);
const aggregatePayCode = ref('');
const remainingSeconds = ref(COUNTDOWN_SECONDS);
const errorMessage = ref<string | null>(null);
const initiating = ref(false);
let countdownTimer: ReturnType<typeof setInterval> | null = null;

const { start, stop, isPolling } = useAggregatePayPolling({
  onSuccess: (payment) => {
    clearCountdown();
    emit('success', payment);
  },
  onFail: (reason) => {
    clearCountdown();
    errorMessage.value = reason;
    emit('fail', reason);
  },
  onTimeout: () => {
    clearCountdown();
    errorMessage.value = '客户未在 5 分钟内付款，已自动取消';
    bestEffortFail();
    emit('fail', 'timeout');
  },
});

const countdownDisplay = computed(() => {
  const m = Math.floor(remainingSeconds.value / 60);
  const s = remainingSeconds.value % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
});

function generateCode(): string {
  return `AGG-${Date.now()}`;
}

async function startPayment() {
  errorMessage.value = null;
  initiating.value = true;
  aggregatePayCode.value = generateCode();
  remainingSeconds.value = COUNTDOWN_SECONDS;
  try {
    const { data, errors } = await apolloClient.mutate({
      mutation: CREATE_AGGREGATE_PAY,
      variables: { aggregatePayCode: aggregatePayCode.value },
    });
    if (errors?.length) throw new Error(errors[0].message);
    const payment = data?.createAggregatePay as { id: string } | undefined;
    if (!payment) throw new Error('创建聚合码支付失败：无响应');
    paymentId.value = payment.id;
    startCountdown();
    start(aggregatePayCode.value);
  } catch (e) {
    ElMessage.error('发起聚合码支付失败：' + (e instanceof Error ? e.message : ''));
    errorMessage.value = e instanceof Error ? e.message : '发起失败';
  } finally {
    initiating.value = false;
  }
}

function startCountdown() {
  clearCountdown();
  countdownTimer = setInterval(() => {
    if (remainingSeconds.value > 0) {
      remainingSeconds.value--;
    } else {
      clearCountdown();
    }
  }, 1000);
}

function clearCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function bestEffortFail() {
  if (!paymentId.value) return;
  apolloClient
    .mutate({
      mutation: FAIL_AGGREGATE_PAY,
      variables: { paymentId: paymentId.value },
    })
    .catch(() => {
      // 忽略：可能已被自动取消或状态已变
    });
}

async function handleCancel() {
  stop();
  clearCountdown();
  bestEffortFail();
  emit('fail', 'cancelled');
}

function handleRetry() {
  errorMessage.value = null;
  paymentId.value = null;
  startPayment();
}

onMounted(() => {
  startPayment();
});

onUnmounted(() => {
  stop();
  clearCountdown();
});
</script>

<template>
  <div class="aggregate-panel">
    <!-- 等待付款中 -->
    <div v-if="!errorMessage" class="waiting">
      <div class="spinner" v-if="isPolling || initiating"></div>
      <h3>等待客户扫码付款...</h3>
      <div class="code-hint">聚合码：{{ aggregatePayCode }}</div>
      <div class="countdown" :class="{ urgent: remainingSeconds <= 60 }">
        剩余时间 {{ countdownDisplay }}
      </div>
      <el-button class="cancel-btn" @click="handleCancel" :disabled="initiating">
        取消
      </el-button>
    </div>

    <!-- 失败/超时 -->
    <div v-else class="failed">
      <div class="fail-icon">⚠</div>
      <h3>付款未完成</h3>
      <p class="fail-reason">{{ errorMessage }}</p>
      <div class="fail-actions">
        <el-button @click="handleCancel">取消</el-button>
        <el-button type="primary" @click="handleRetry">重新等待</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.aggregate-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  gap: 16px;
  min-height: 320px;
}
.waiting,
.failed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  text-align: center;
}
.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid #e4e7ed;
  border-top-color: #409eff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
h3 {
  margin: 0;
  font-size: 20px;
  color: #303133;
}
.code-hint {
  font-size: 13px;
  color: #909399;
  font-family: monospace;
}
.countdown {
  font-size: 28px;
  font-weight: 700;
  color: #409eff;
}
.countdown.urgent {
  color: #f56c6c;
}
.cancel-btn {
  margin-top: 12px;
}
.fail-icon {
  font-size: 48px;
  color: #e6a23c;
}
.fail-reason {
  color: #606266;
  font-size: 14px;
}
.fail-actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
</style>
