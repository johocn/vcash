import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Order, Payment, RequestContext, TransactionalConnection } from '@vendure/core';
import { Connection } from 'typeorm';

import { SYNC_STATUS } from '../constants';
import { OfflineSyncQueue } from '../entities/offline-sync-queue.entity';
import {
  OfflinePaymentSyncRecord,
  SyncedPaymentResult,
  SyncPaymentFailureResult,
} from '../types';
import { OfflineSyncQueueService } from './sync-queue.service';

/**
 * 离线 Payment 同步服务：
 * 1. 幂等校验（同 sync-order 逻辑）
 * 2. 按 orderKey 找已同步的 Order（从 OfflineSyncQueue 查 syncedOrderId）
 * 3. 创建 Payment（method, amount, state='Settled'）并关联 Order
 * 4. 成功 markSuccess / 失败 markFailed
 *
 * syncedOrderId 字段在 type='payment' 记录中复用为 paymentId。
 */
@Injectable()
export class SyncPaymentService {
  constructor(
    @Inject(OfflineSyncQueueService) private queueService: OfflineSyncQueueService,
    @InjectConnection() private connection: Connection,
    @Inject(TransactionalConnection) private transactionalConnection: TransactionalConnection,
  ) {}

  async syncSinglePayment(
    ctx: any,
    payment: OfflinePaymentSyncRecord,
  ): Promise<SyncedPaymentResult | SyncPaymentFailureResult> {
    // 1. 幂等校验
    const existing = await this.queueService.findExisting(payment.idempotencyKey);
    if (existing) {
      if (existing.status === SYNC_STATUS.SUCCESS) {
        return {
          idempotencyKey: payment.idempotencyKey,
          paymentId: existing.syncedOrderId ?? 0,
          orderId: 0,
          status: 'duplicate',
        };
      }
      if (existing.status === SYNC_STATUS.FAILED) {
        if (
          this.queueService.isStaleVersion(
            new Date(payment.clientUpdatedAt),
            new Date(existing.clientUpdatedAt),
          )
        ) {
          return {
            idempotencyKey: payment.idempotencyKey,
            error: 'stale version: clientUpdatedAt is older than existing record',
            code: 'CONFLICT',
            status: 'failed',
          };
        }
        await this.queueService.delete(existing.id);
      } else {
        return {
          idempotencyKey: payment.idempotencyKey,
          paymentId: existing.syncedOrderId ?? 0,
          orderId: 0,
          status: 'duplicate',
        };
      }
    }

    // 2. 创建 pending 记录
    const queueItem = await this.queueService.savePending({
      idempotencyKey: payment.idempotencyKey,
      type: 'payment',
      payload: payment,
      clientCreatedAt: new Date(payment.clientCreatedAt),
      clientUpdatedAt: new Date(payment.clientUpdatedAt),
    });

    // 3. 找已同步的 Order
    try {
      const orderQueue = await this.queueService.findExisting(payment.orderKey);
      if (!orderQueue || orderQueue.type !== 'order' || !orderQueue.syncedOrderId) {
        await this.queueService.markFailed(queueItem.id, {
          code: 'ORDER_NOT_SYNCED',
          message: `未找到 orderKey=${payment.orderKey} 对应的已同步订单`,
        });
        return {
          idempotencyKey: payment.idempotencyKey,
          error: `未找到 orderKey=${payment.orderKey} 对应的已同步订单`,
          code: 'ORDER_NOT_SYNCED',
          status: 'failed',
        };
      }

      const orderId = orderQueue.syncedOrderId;

      // 4. 创建 Payment（state='Settled'）并关联 Order
      const savedPayment = await this.transactionalConnection
        .withTransaction(ctx, async () => {
          const paymentRepo = this.connection.getRepository(Payment);
          const newPayment = new Payment();
          newPayment.method = payment.method;
          newPayment.amount = payment.amount;
          newPayment.state = 'Settled';
          newPayment.transactionId = payment.transactionId as string;
          newPayment.metadata = payment.metadata ?? {};
          newPayment.order = { id: orderId } as Order;
          return paymentRepo.save(newPayment);
        });

      // 5. markSuccess（复用 syncedOrderId 字段存 paymentId）
      await this.queueService.markSuccess(
        queueItem.id,
        Number(savedPayment.id),
        String(orderId),
      );
      return {
        idempotencyKey: payment.idempotencyKey,
        paymentId: Number(savedPayment.id),
        orderId,
        status: 'success',
      };
    } catch (e: any) {
      const code = e.code ?? 'UNKNOWN';
      await this.queueService.markFailed(queueItem.id, { code, message: e.message });
      return {
        idempotencyKey: payment.idempotencyKey,
        error: e.message,
        code,
        status: 'failed',
      };
    }
  }
}
