import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';

import { SYNC_STATUS } from '../constants';
import { OfflineSyncQueue } from '../entities/offline-sync-queue.entity';

/**
 * 离线同步队列服务：幂等校验 + LWW + 状态机。
 * - findExisting: 按 idempotencyKey 查已有记录
 * - savePending: 新建 pending 记录
 * - markSuccess/markFailed/markNeedsManual: 状态流转
 * - isStaleVersion: LWW 比较（新 clientUpdatedAt 更旧则返回 true）
 */
@Injectable()
export class OfflineSyncQueueService {
  constructor(@InjectConnection() private connection: Connection) {}

  async findExisting(idempotencyKey: string): Promise<OfflineSyncQueue | null> {
    return this.connection.getRepository(OfflineSyncQueue).findOne({
      where: { idempotencyKey },
    });
  }

  async savePending(record: {
    idempotencyKey: string;
    type: 'order' | 'payment' | 'session';
    payload: any;
    clientCreatedAt: Date;
    clientUpdatedAt: Date;
    sessionCode?: string;
  }): Promise<OfflineSyncQueue> {
    const item = new OfflineSyncQueue();
    item.idempotencyKey = record.idempotencyKey;
    item.type = record.type;
    item.payload = record.payload;
    item.clientCreatedAt = record.clientCreatedAt;
    item.clientUpdatedAt = record.clientUpdatedAt;
    item.status = SYNC_STATUS.PENDING;
    item.retryCount = 0;
    item.sessionCode = record.sessionCode;
    return this.connection.getRepository(OfflineSyncQueue).save(item);
  }

  async markSuccess(
    id: number,
    syncedOrderId: number,
    syncedOrderCode: string,
  ): Promise<void> {
    await this.connection.getRepository(OfflineSyncQueue).update(id, {
      status: SYNC_STATUS.SUCCESS,
      syncedOrderId,
      syncedOrderCode,
      syncedAt: new Date(),
    });
  }

  async markFailed(id: number, error: { code: string; message: string }): Promise<void> {
    const existing = await this.connection
      .getRepository(OfflineSyncQueue)
      .findOne({ where: { id } });
    const retryCount = (existing?.retryCount ?? 0) + 1;
    const status = retryCount > 5 ? SYNC_STATUS.NEEDS_MANUAL : SYNC_STATUS.FAILED;
    await this.connection.getRepository(OfflineSyncQueue).update(id, {
      status,
      syncError: error,
      retryCount,
    });
  }

  async markNeedsManual(id: number): Promise<void> {
    await this.connection.getRepository(OfflineSyncQueue).update(id, {
      status: SYNC_STATUS.NEEDS_MANUAL,
    });
  }

  /**
   * LWW 比较：新 clientUpdatedAt 更旧（更早）则返回 true（stale）。
   * 相同时间戳不算 stale（允许重试）。
   */
  isStaleVersion(clientUpdatedAt: Date, existingClientUpdatedAt: Date): boolean {
    return new Date(clientUpdatedAt).getTime() < new Date(existingClientUpdatedAt).getTime();
  }

  async delete(id: number): Promise<void> {
    await this.connection.getRepository(OfflineSyncQueue).delete(id);
  }
}
