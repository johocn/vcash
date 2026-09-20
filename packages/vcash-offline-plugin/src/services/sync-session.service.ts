import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Order, RequestContext, TransactionalConnection } from '@vendure/core';
import { PosSessionService } from '@vcash/pos-plugin';
import { Connection } from 'typeorm';

import { SYNC_STATUS } from '../constants';
import { OfflineSyncQueue } from '../entities/offline-sync-queue.entity';
import {
  OfflineSessionRecord,
  SyncedSessionResult,
  SyncSessionFailureResult,
} from '../types';
import { OfflineSyncQueueService } from './sync-queue.service';

/**
 * 离线 PosSession 同步服务：
 * 1. 幂等校验
 * 2. 调 PosSessionService.openSession 创建 PosSession（terminalCode + openingFloat）
 * 3. 关联已同步的 Orders（通过 sessionCode 查 OfflineSyncQueue → 更新 Order.customFields.posSessionId）
 * 4. 如果 session.state='closed'：调 closeSession（closingCash）
 * 5. 成功 markSuccess（syncedOrderId 复用存 sessionId，syncedOrderCode 复用存 sessionCode）
 *
 * 关键约束：
 * - PosSessionService.openSession 不允许同一终端同时存在 open session
 * - 离线 sessionCode 是客户端生成的临时标识，用于关联 OfflineSyncQueue 中的 order 记录
 *   服务端 PosSession.code 由 generateSessionCode 自动生成
 * - 关联 Orders 时用 PRAGMA 查找 customFields_posSessionId 实际列名（参考 shift-report.service.ts）
 */
@Injectable()
export class SyncSessionService {
  constructor(
    @Inject(OfflineSyncQueueService) private queueService: OfflineSyncQueueService,
    @Inject(PosSessionService) private posSessionService: PosSessionService,
    @InjectConnection() private connection: Connection,
    @Inject(TransactionalConnection) private transactionalConnection: TransactionalConnection,
  ) {}

  async syncSingleSession(
    ctx: any,
    session: OfflineSessionRecord,
  ): Promise<SyncedSessionResult | SyncSessionFailureResult> {
    // 1. 幂等校验
    const existing = await this.queueService.findExisting(session.idempotencyKey);
    if (existing) {
      if (existing.status === SYNC_STATUS.SUCCESS) {
        return {
          idempotencyKey: session.idempotencyKey,
          sessionId: existing.syncedOrderId ?? 0,
          sessionCode: existing.syncedOrderCode ?? '',
          state: existing.payload?.state ?? 'open',
          status: 'duplicate',
        };
      }
      if (existing.status === SYNC_STATUS.FAILED) {
        if (
          this.queueService.isStaleVersion(
            new Date(session.clientUpdatedAt),
            new Date(existing.clientUpdatedAt),
          )
        ) {
          return {
            idempotencyKey: session.idempotencyKey,
            error: 'stale version: clientUpdatedAt is older than existing record',
            code: 'CONFLICT',
            status: 'failed',
          };
        }
        await this.queueService.delete(existing.id);
      } else {
        return {
          idempotencyKey: session.idempotencyKey,
          sessionId: existing.syncedOrderId ?? 0,
          sessionCode: existing.syncedOrderCode ?? '',
          state: existing.payload?.state ?? 'open',
          status: 'duplicate',
        };
      }
    }

    // 2. 创建 pending 记录
    const queueItem = await this.queueService.savePending({
      idempotencyKey: session.idempotencyKey,
      type: 'session',
      payload: session,
      clientCreatedAt: new Date(session.clientCreatedAt),
      clientUpdatedAt: new Date(session.clientUpdatedAt),
      sessionCode: session.sessionCode,
    });

    try {
      // 3. 开班
      const opened = await this.posSessionService.openSession({
        terminalCode: session.terminalCode,
        operatorId: session.operatorId,
        openingFloat: session.openingFloat,
      });

      // 4. 关联已同步的 Orders（通过 sessionCode 查 OfflineSyncQueue）
      await this.associateOrders(opened.id, session.sessionCode);

      // 5. 如果离线记录 state='closed'，立即关班
      let finalState: 'open' | 'closed' = 'open';
      if (session.state === 'closed') {
        const closed = await this.posSessionService.closeSession({
          sessionId: opened.id,
          closingCash: session.closingCash ?? 0,
        });
        finalState = closed.state;
      } else {
        finalState = opened.state;
      }

      // 6. markSuccess（syncedOrderId 存 sessionId，syncedOrderCode 存 sessionCode）
      await this.queueService.markSuccess(
        queueItem.id,
        Number(opened.id),
        opened.code,
      );
      return {
        idempotencyKey: session.idempotencyKey,
        sessionId: Number(opened.id),
        sessionCode: opened.code,
        state: finalState,
        status: 'success',
      };
    } catch (e: any) {
      const code = e.code ?? 'UNKNOWN';
      await this.queueService.markFailed(queueItem.id, { code, message: e.message });
      return {
        idempotencyKey: session.idempotencyKey,
        error: e.message,
        code,
        status: 'failed',
      };
    }
  }

  /**
   * 关联已同步的 Orders 到新创建的 PosSession。
   * 通过 OfflineSyncQueue.sessionCode 查找同班次的 order 记录，
   * 取 syncedOrderId 后用 PRAGMA 查找 customFields_posSessionId 列名做 raw SQL 更新。
   */
  private async associateOrders(sessionId: number, offlineSessionCode: string): Promise<void> {
    const orderQueues = await this.connection.getRepository(OfflineSyncQueue).find({
      where: { type: 'order', sessionCode: offlineSessionCode, status: SYNC_STATUS.SUCCESS },
    });
    if (orderQueues.length === 0) return;

    // PRAGMA 查找 customFields_posSessionId 实际列名
    const columns = (await this.connection.query(
      'PRAGMA table_info("order")',
    )) as Array<{ name: string }>;
    const colName = columns.find(c =>
      c.name.toLowerCase().replace(/_/g, '').includes('possessionid'),
    )?.name;
    if (!colName) return;

    for (const oq of orderQueues) {
      if (!oq.syncedOrderId) continue;
      await this.connection.query(
        `UPDATE "order" SET "${colName}" = ? WHERE id = ?`,
        [sessionId, oq.syncedOrderId],
      );
    }
  }
}
