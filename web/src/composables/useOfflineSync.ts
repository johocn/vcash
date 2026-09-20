import { ref, onMounted, onUnmounted } from 'vue';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import {
  db,
  type OfflineOrderRecord,
  type OfflinePaymentRecord,
  type OfflineSessionRecord,
} from '@/db/dexie';
import { useOfflineStore } from '@/stores/offline';

const SYNC_ORDERS = gql`
  mutation SyncOrders($input: SyncOrdersInput!) {
    syncOrders(input: $input) {
      succeeded {
        idempotencyKey
        orderId
        orderCode
        status
      }
      failed {
        idempotencyKey
        error
        code
        status
      }
    }
  }
`;

const SYNC_PAYMENTS = gql`
  mutation SyncPayments($input: SyncPaymentsInput!) {
    syncPayments(input: $input) {
      succeeded {
        idempotencyKey
        paymentId
        orderId
        status
      }
      failed {
        idempotencyKey
        error
        code
        status
      }
    }
  }
`;

const SYNC_SESSIONS = gql`
  mutation SyncSessions($input: SyncSessionsInput!) {
    syncSessions(input: $input) {
      succeeded {
        idempotencyKey
        sessionId
        sessionCode
        state
        status
      }
      failed {
        idempotencyKey
        error
        code
        status
      }
    }
  }
`;

/** 取得到期重试的 failed 记录 + 全部 pending 记录 */
async function pickDue<T extends { syncStatus: string; nextRetryAt?: string; idempotencyKey: string }>(
  table: import('dexie').Table<T, string>,
): Promise<T[]> {
  const candidates = await table
    .where('syncStatus')
    .anyOf(['pending', 'failed'])
    .toArray();
  const now = Date.now();
  return candidates.filter((r) => {
    if (r.syncStatus === 'pending') return true;
    if (r.syncStatus === 'failed' && r.nextRetryAt) {
      return new Date(r.nextRetryAt).getTime() <= now;
    }
    return false;
  });
}

/** 批量标记为 syncing 状态 */
function markSyncing<T extends { idempotencyKey: string }>(
  table: import('dexie').Table<T, string>,
  records: T[],
): Promise<unknown[]> {
  return Promise.all(
    records.map((r) => table.update(r.idempotencyKey, { syncStatus: 'syncing' } as Record<string, unknown> as never)),
  );
}

export function useOfflineSync() {
  const offlineStore = useOfflineStore();
  const isSyncing = ref(false);

  async function syncOrders() {
    const due = await pickDue(db.orders);
    if (due.length === 0) return;
    await markSyncing(db.orders, due);
    await offlineStore.updateCounts();

    for (const order of due) {
      const input = {
        idempotencyKey: order.idempotencyKey,
        clientCreatedAt: order.clientCreatedAt,
        clientUpdatedAt: order.clientUpdatedAt,
        sessionCode: order.sessionCode,
        terminalCode: order.terminalCode,
        orderType: order.orderType,
        lines: order.lines,
        payments: order.payments,
        totalAmount: order.totalAmount,
      };
      try {
        const { data, errors } = await apolloClient.mutate({
          mutation: SYNC_ORDERS,
          variables: { input: { orders: [input] } },
        });
        if (errors?.length && !data) throw new Error(errors[0].message);
        const result = data?.syncOrders;
        const succ = result?.succeeded?.[0];
        const fail = result?.failed?.[0];
        if (succ && (succ.status === 'success' || succ.status === 'duplicate')) {
          await offlineStore.markOrderSynced(
            succ.idempotencyKey,
            Number(succ.orderId),
            succ.orderCode ?? '',
          );
        } else if (fail) {
          await offlineStore.markOrderFailed(
            fail.idempotencyKey,
            fail.error || fail.code || '同步失败',
          );
        } else {
          await offlineStore.markOrderFailed(order.idempotencyKey, '同步无响应');
        }
      } catch (e) {
        await offlineStore.markOrderFailed(
          order.idempotencyKey,
          e instanceof Error ? e.message : '网络错误',
        );
      }
    }
  }

  async function syncPayments() {
    const due = await pickDue(db.payments);
    if (due.length === 0) return;
    await markSyncing(db.payments, due);
    await offlineStore.updateCounts();

    for (const payment of due) {
      const input = {
        idempotencyKey: payment.idempotencyKey,
        clientCreatedAt: payment.clientCreatedAt,
        clientUpdatedAt: payment.clientUpdatedAt,
        orderKey: payment.orderKey,
        method: payment.method,
        amount: payment.amount,
        transactionId: payment.transactionId,
        metadata: payment.metadata ?? null,
      };
      try {
        const { data, errors } = await apolloClient.mutate({
          mutation: SYNC_PAYMENTS,
          variables: { input: { payments: [input] } },
        });
        if (errors?.length && !data) throw new Error(errors[0].message);
        const result = data?.syncPayments;
        const succ = result?.succeeded?.[0];
        const fail = result?.failed?.[0];
        if (succ && (succ.status === 'success' || succ.status === 'duplicate')) {
          await db.payments.update(succ.idempotencyKey, {
            syncStatus: 'success',
            syncError: undefined,
            nextRetryAt: undefined,
          });
        } else if (fail) {
          await db.payments.update(fail.idempotencyKey, {
            syncStatus: 'failed',
            syncError: fail.error || fail.code,
          });
        }
      } catch (e) {
        await db.payments.update(payment.idempotencyKey, {
          syncStatus: 'failed',
          syncError: e instanceof Error ? e.message : '网络错误',
        });
      }
    }
    await offlineStore.updateCounts();
  }

  async function syncSessions() {
    const due = await pickDue(db.sessions);
    if (due.length === 0) return;
    await markSyncing(db.sessions, due);
    await offlineStore.updateCounts();

    for (const session of due) {
      if (session.operatorId == null) {
        // 缺 operatorId 无法同步，跳过（需人工补录）
        continue;
      }
      const input = {
        idempotencyKey: session.idempotencyKey,
        clientCreatedAt: session.clientCreatedAt,
        clientUpdatedAt: session.clientUpdatedAt,
        sessionCode: session.code,
        terminalCode: session.terminalCode,
        operatorId: session.operatorId,
        openingFloat: session.openingFloat,
        state: session.state,
        closingCash: session.closingCash,
      };
      try {
        const { data, errors } = await apolloClient.mutate({
          mutation: SYNC_SESSIONS,
          variables: { input: { sessions: [input] } },
        });
        if (errors?.length && !data) throw new Error(errors[0].message);
        const result = data?.syncSessions;
        const succ = result?.succeeded?.[0];
        const fail = result?.failed?.[0];
        if (succ && (succ.status === 'success' || succ.status === 'duplicate')) {
          await db.sessions.update(session.code, {
            syncStatus: 'success',
            syncError: undefined,
          });
        } else if (fail) {
          await db.sessions.update(session.code, {
            syncStatus: 'failed',
            syncError: fail.error || fail.code,
          });
        }
      } catch (e) {
        await db.sessions.update(session.code, {
          syncStatus: 'failed',
          syncError: e instanceof Error ? e.message : '网络错误',
        });
      }
    }
    await offlineStore.updateCounts();
  }

  async function syncAll() {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    if (isSyncing.value) return;
    isSyncing.value = true;
    try {
      await syncOrders();
      await syncPayments();
      await syncSessions();
    } finally {
      isSyncing.value = false;
      await offlineStore.updateCounts();
    }
  }

  const handleOnline = () => {
    syncAll();
  };

  onMounted(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', handleOnline);
    if (navigator.onLine) syncAll();
  });
  onUnmounted(() => {
    if (typeof window === 'undefined') return;
    window.removeEventListener('online', handleOnline);
  });

  return { syncAll, isSyncing };
}

// 显式标注类型导出，避免未使用告警
export type { OfflineOrderRecord, OfflinePaymentRecord, OfflineSessionRecord };
