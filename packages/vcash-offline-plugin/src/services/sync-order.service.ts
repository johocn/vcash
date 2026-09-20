import { Inject, Injectable } from '@nestjs/common';
import { PosOrderService } from '@vcash/pos-plugin';

import { SYNC_STATUS } from '../constants';
import { OfflineSyncQueue } from '../entities/offline-sync-queue.entity';
import { OfflineSyncQueueService } from './sync-queue.service';
import { OfflineOrderRecord, SyncFailureResult, SyncedOrderResult } from '../types';

/**
 * 离线订单同步服务：
 * 1. 幂等校验：success → duplicate；failed + LWW → 重试；failed + stale → CONFLICT
 * 2. 创建 pending 队列记录
 * 3. 调用 PosOrderService.createOrderFromOffline 落库
 * 4. 成功 markSuccess / 失败 markFailed
 */
@Injectable()
export class SyncOrderService {
  constructor(
    @Inject(OfflineSyncQueueService) private queueService: OfflineSyncQueueService,
    @Inject(PosOrderService) private posOrderService: PosOrderService,
  ) {}

  async syncSingleOrder(
    ctx: any,
    order: OfflineOrderRecord,
  ): Promise<SyncedOrderResult | SyncFailureResult> {
    // 1. 幂等校验
    const existing = await this.queueService.findExisting(order.idempotencyKey);
    if (existing) {
      if (existing.status === SYNC_STATUS.SUCCESS) {
        return {
          idempotencyKey: order.idempotencyKey,
          orderId: existing.syncedOrderId!,
          orderCode: existing.syncedOrderCode!,
          status: 'duplicate',
        };
      }
      if (existing.status === SYNC_STATUS.FAILED) {
        // LWW：新 clientUpdatedAt 更旧 → CONFLICT；更新 → 删除旧记录重试
        if (
          this.queueService.isStaleVersion(
            new Date(order.clientUpdatedAt),
            new Date(existing.clientUpdatedAt),
          )
        ) {
          return {
            idempotencyKey: order.idempotencyKey,
            error: 'stale version: clientUpdatedAt is older than existing record',
            code: 'CONFLICT',
            status: 'failed',
          };
        }
        await this.queueService.delete(existing.id);
      } else {
        // pending / syncing / cancelled / needs_manual → 不允许重复处理
        return {
          idempotencyKey: order.idempotencyKey,
          orderId: existing.syncedOrderId ?? 0,
          orderCode: existing.syncedOrderCode ?? '',
          status: 'duplicate',
        };
      }
    }

    // 2. 创建 pending 记录
    const queueItem = await this.queueService.savePending({
      idempotencyKey: order.idempotencyKey,
      type: 'order',
      payload: order,
      clientCreatedAt: new Date(order.clientCreatedAt),
      clientUpdatedAt: new Date(order.clientUpdatedAt),
      sessionCode: order.sessionCode,
    });

    // 3. 调用 PosOrderService 落库
    try {
      const newOrder = await this.posOrderService.createOrderFromOffline(ctx, order);
      await this.queueService.markSuccess(queueItem.id, Number(newOrder.id), newOrder.code);
      return {
        idempotencyKey: order.idempotencyKey,
        orderId: Number(newOrder.id),
        orderCode: newOrder.code,
        status: 'success',
      };
    } catch (e: any) {
      const code = e.code ?? (e.message?.includes('Insufficient stock') ? 'OUT_OF_STOCK' : 'UNKNOWN');
      await this.queueService.markFailed(queueItem.id, { code, message: e.message });
      return {
        idempotencyKey: order.idempotencyKey,
        error: e.message,
        code,
        status: 'failed',
      };
    }
  }
}
