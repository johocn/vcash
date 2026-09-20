import { Inject } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  Allow,
  Ctx,
  ID,
  Permission,
  Refund,
  RequestContext,
  UserInputError,
} from '@vendure/core';

import { POS_PERMISSIONS, posSessionPermission } from '../constants';
import { RefundService } from '../services/refund.service';

/**
 * 退货退款 API：
 * - createPosRefund: 对已完成订单创建退款（现金立即结算，聚合码标记人工退款）
 * - settleManualRefund: 手动结算待处理退款
 * - posRefunds: 查询班次内退款列表
 */
@Resolver()
export class AdminRefundResolver {
  constructor(@Inject(RefundService) private refundService: RefundService) {}

  /**
   * 创建退货退款。
   * 需原单状态为 PaymentSettled 等已完成状态。
   */
  @Mutation()
  @Allow(Permission.ReadOrder, posSessionPermission.Update)
  async createPosRefund(
    @Args('input')
    input: {
      originalOrderId: string;
      paymentId: string;
      amount: number;
      reason?: string;
    },
    @Ctx() ctx: RequestContext,
  ): Promise<Refund> {
    return this.refundService.createRefund(ctx, {
      originalOrderId: input.originalOrderId,
      paymentId: input.paymentId,
      amount: input.amount,
      reason: input.reason,
    });
  }

  /**
   * 手动结算待处理退款（聚合码已结算的需人工处理）。
   */
  @Mutation()
  @Allow(Permission.ReadOrder, posSessionPermission.Update)
  async settleManualRefund(
    @Args('input')
    input: { refundId: string; transactionId: string },
    @Ctx() ctx: RequestContext,
  ): Promise<Refund> {
    return this.refundService.settleManualRefund(ctx, {
      refundId: input.refundId,
      transactionId: input.transactionId,
    });
  }

  /**
   * 查询班次内所有退款单。
   */
  @Query()
  @Allow(Permission.ReadOrder, posSessionPermission.Read)
  async posRefunds(
    @Args('sessionId') sessionId: string,
  ): Promise<Refund[]> {
    return this.refundService.findRefundsBySession(parseInt(sessionId, 10));
  }
}
