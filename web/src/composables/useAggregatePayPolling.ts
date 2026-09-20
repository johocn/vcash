import { ref, onUnmounted } from 'vue';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';

const AGGREGATE_PAY_BY_CODE = gql`
  query AggregatePayByCode($aggregatePayCode: String!) {
    aggregatePayByCode(aggregatePayCode: $aggregatePayCode) {
      id
      state
      method
      amount
      customFields {
        aggregatePayCode
        aggregatePayStatus
      }
      order {
        id
        state
      }
    }
  }
`;

const SETTLE_AGGREGATE_PAY = gql`
  mutation SettleAggregatePay($paymentId: ID!) {
    settleAggregatePay(paymentId: $paymentId) {
      id
      state
      method
      amount
      customFields {
        aggregatePayCode
        aggregatePayStatus
      }
    }
  }
`;

export interface PolledPayment {
  id: string;
  state: string;
  method: string;
  amount: number;
  customFields: {
    aggregatePayCode: string;
    aggregatePayStatus: string;
  };
  order: { id: string; state: string };
}

export interface UseAggregatePayPollingOptions {
  /** state=Authorized 时自动 settle 成功后回调 */
  onSuccess: (payment: PolledPayment) => void;
  /** state=Cancelled 时回调 */
  onFail: (reason: string) => void;
  /** 超时 5 分钟（150 次 × 2s）回调 */
  onTimeout: () => void;
}

const MAX_POLLS = 150;
const INTERVAL_MS = 2000;

/**
 * 聚合码支付轮询 composable：
 * start(aggregatePayCode) → 每 2s 查 aggregatePayByCode
 * - state=Authorized → 自动调 settleAggregatePay → onSuccess
 * - state=Cancelled → onFail
 * - 超时 150 次（≈5 分钟）→ onTimeout
 * stop() 清理 timer。
 */
export function useAggregatePayPolling(options: UseAggregatePayPollingOptions) {
  const isPolling = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pollCount = 0;
  let active = false;

  async function pollOnce(aggregatePayCode: string) {
    try {
      const { data, errors } = await apolloClient.query({
        query: AGGREGATE_PAY_BY_CODE,
        variables: { aggregatePayCode },
        fetchPolicy: 'network-only',
      });
      if (!active) return;
      if (errors?.length && !data) throw new Error(errors[0].message);
      const payment = (data?.aggregatePayByCode ?? null) as PolledPayment | null;
      if (!payment) return;

      if (payment.state === 'Authorized') {
        stop();
        try {
          const { data: settleData, errors: settleErrors } = await apolloClient.mutate({
            mutation: SETTLE_AGGREGATE_PAY,
            variables: { paymentId: payment.id },
          });
          if (settleErrors?.length) throw new Error(settleErrors[0].message);
          const settled = settleData?.settleAggregatePay as PolledPayment;
          options.onSuccess(settled);
        } catch (e) {
          options.onFail(e instanceof Error ? e.message : '结算失败');
        }
        return;
      }
      if (payment.state === 'Settled') {
        stop();
        options.onSuccess(payment);
        return;
      }
      if (payment.state === 'Cancelled') {
        stop();
        options.onFail('客户已取消付款');
        return;
      }
    } catch {
      // 网络错误静默重试
    }
  }

  function start(aggregatePayCode: string) {
    stop();
    pollCount = 0;
    active = true;
    isPolling.value = true;

    const tick = async () => {
      if (!active) return;
      pollCount++;
      if (pollCount > MAX_POLLS) {
        stop();
        options.onTimeout();
        return;
      }
      await pollOnce(aggregatePayCode);
      if (active) {
        timer = setTimeout(tick, INTERVAL_MS);
      }
    };

    tick();
  }

  function stop() {
    active = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    isPolling.value = false;
  }

  onUnmounted(() => stop());

  return { start, stop, isPolling };
}
