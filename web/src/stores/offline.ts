import { defineStore } from 'pinia';
import { db } from '@/db/dexie';

/** 指数退避：min(60 * 2^n, 1800) 秒 */
export function backoffSeconds(retryCount: number): number {
  return Math.min(60 * Math.pow(2, retryCount), 1800);
}

export const MAX_RETRY = 5;

export const useOfflineStore = defineStore('offline', {
  state: () => ({
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    pendingCount: 0,
    syncingCount: 0,
    failedCount: 0,
  }),
  getters: {
    hasPending: (state) => state.pendingCount > 0,
  },
  actions: {
    setOnline(online: boolean) {
      this.isOnline = online;
    },
    /** 监听 window online/offline 事件，初始化网络状态 */
    detectNetwork() {
      if (typeof window === 'undefined') return;
      this.isOnline = navigator.onLine;
      window.addEventListener('online', () => this.setOnline(true));
      window.addEventListener('offline', () => this.setOnline(false));
    },
    /** 从 Dexie 统计 pending/syncing/failed 订单数 */
    async updateCounts() {
      try {
        const [pending, syncing, failed] = await Promise.all([
          db.orders.where('syncStatus').equals('pending').count(),
          db.orders.where('syncStatus').equals('syncing').count(),
          db.orders.where('syncStatus').anyOf(['failed', 'needs_manual']).count(),
        ]);
        this.pendingCount = pending;
        this.syncingCount = syncing;
        this.failedCount = failed;
      } catch {
        // 表未初始化等异常静默忽略
      }
    },
    /** 标记订单同步成功 */
    async markOrderSynced(idempotencyKey: string, orderId: number, orderCode: string) {
      await db.orders.update(idempotencyKey, {
        syncStatus: 'success',
        syncedOrderId: orderId,
        syncedOrderCode: orderCode,
        syncError: undefined,
        nextRetryAt: undefined,
      });
      await this.updateCounts();
    },
    /** 标记订单同步失败（含指数退避调度 + 超限转 needs_manual） */
    async markOrderFailed(idempotencyKey: string, error: string) {
      const existing = await db.orders.get(idempotencyKey);
      const retryCount = (existing?.retryCount ?? 0) + 1;
      const isLast = retryCount >= MAX_RETRY;
      const nextRetryAt = isLast
        ? undefined
        : new Date(Date.now() + backoffSeconds(retryCount) * 1000).toISOString();
      await db.orders.update(idempotencyKey, {
        syncStatus: isLast ? 'needs_manual' : 'failed',
        syncError: error,
        retryCount,
        nextRetryAt,
      });
      await this.updateCounts();
    },
  },
});
