import { Inject } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, RequestContext } from '@vendure/core';

import { offlineSyncPermission } from '../constants';
import { IncrementalSyncService } from '../services/incremental-sync.service';
import { SyncOrderService } from '../services/sync-order.service';
import { SyncPaymentService } from '../services/sync-payment.service';
import { SyncSessionService } from '../services/sync-session.service';
import {
  OfflineOrderRecord,
  OfflinePaymentSyncRecord,
  OfflineSessionRecord,
  SyncFailureResult,
  SyncedOrderResult,
  SyncedPaymentResult,
  SyncedSessionResult,
  SyncPaymentFailureResult,
  SyncSessionFailureResult,
} from '../types';

@Resolver()
export class AdminSyncResolver {
  constructor(
    @Inject(SyncOrderService) private syncOrderService: SyncOrderService,
    @Inject(SyncPaymentService) private syncPaymentService: SyncPaymentService,
    @Inject(SyncSessionService) private syncSessionService: SyncSessionService,
    @Inject(IncrementalSyncService) private incrementalSyncService: IncrementalSyncService,
  ) {}

  @Mutation()
  @Allow(offlineSyncPermission.Update)
  async syncOrders(
    @Args('input') input: { orders: OfflineOrderRecord[] },
    @Ctx() ctx: RequestContext,
  ): Promise<{ succeeded: SyncedOrderResult[]; failed: SyncFailureResult[] }> {
    const succeeded: SyncedOrderResult[] = [];
    const failed: SyncFailureResult[] = [];

    for (const order of input.orders) {
      const result = await this.syncOrderService.syncSingleOrder(ctx, order);
      if (result.status === 'failed') {
        failed.push(result);
      } else {
        succeeded.push(result);
      }
    }

    return { succeeded, failed };
  }

  @Mutation()
  @Allow(offlineSyncPermission.Update)
  async syncPayments(
    @Args('input') input: { payments: OfflinePaymentSyncRecord[] },
    @Ctx() ctx: RequestContext,
  ): Promise<{ succeeded: SyncedPaymentResult[]; failed: SyncPaymentFailureResult[] }> {
    const succeeded: SyncedPaymentResult[] = [];
    const failed: SyncPaymentFailureResult[] = [];

    for (const payment of input.payments) {
      const result = await this.syncPaymentService.syncSinglePayment(ctx, payment);
      if (result.status === 'failed') {
        failed.push(result);
      } else {
        succeeded.push(result);
      }
    }

    return { succeeded, failed };
  }

  @Mutation()
  @Allow(offlineSyncPermission.Update)
  async syncSessions(
    @Args('input') input: { sessions: OfflineSessionRecord[] },
    @Ctx() ctx: RequestContext,
  ): Promise<{ succeeded: SyncedSessionResult[]; failed: SyncSessionFailureResult[] }> {
    const succeeded: SyncedSessionResult[] = [];
    const failed: SyncSessionFailureResult[] = [];

    for (const session of input.sessions) {
      const result = await this.syncSessionService.syncSingleSession(ctx, session);
      if (result.status === 'failed') {
        failed.push(result);
      } else {
        succeeded.push(result);
      }
    }

    return { succeeded, failed };
  }

  @Query()
  @Allow(offlineSyncPermission.Read)
  async syncProducts(
    @Args('since') since: Date,
    @Args('limit') limit: number,
    @Ctx() ctx: RequestContext,
  ) {
    return this.incrementalSyncService.syncProducts(ctx, since, limit);
  }

  @Query()
  @Allow(offlineSyncPermission.Read)
  async syncMembers(
    @Args('since') since: Date,
    @Args('limit') limit: number,
    @Ctx() ctx: RequestContext,
  ) {
    return this.incrementalSyncService.syncMembers(ctx, since, limit);
  }
}
