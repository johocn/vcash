import { Inject } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';

import { ReportService } from '../services/report.service';

/**
 * 报表查询 API（店长/老板维度）。
 *
 * 权限：复用 Vendure 原生 ReadOrder Permission（店长/老板角色默认拥有）。
 * 数据范围：ctx.channelId 自动过滤，仅返回当前 channel 数据。
 *
 * 四类报表对应四个 Query：
 * - todayOverview: 今日概览（实时）
 * - salesReport: 日/区间报表（按天趋势）
 * - monthlyReport: 月度报表（含环比）
 * - topProducts: 商品销量 TOP
 */
@Resolver()
export class AdminReportResolver {
  constructor(@Inject(ReportService) private reportService: ReportService) {}

  @Query()
  @Allow(Permission.ReadOrder)
  async todayOverview(@Ctx() ctx: RequestContext) {
    return this.reportService.todayOverview(ctx);
  }

  @Query()
  @Allow(Permission.ReadOrder)
  async salesReport(
    @Ctx() ctx: RequestContext,
    @Args('startDate') startDate: string,
    @Args('endDate') endDate: string,
  ) {
    return this.reportService.salesReport(ctx, startDate, endDate);
  }

  @Query()
  @Allow(Permission.ReadOrder)
  async monthlyReport(
    @Ctx() ctx: RequestContext,
    @Args('year') year: number,
    @Args('month') month: number,
  ) {
    return this.reportService.monthlyReport(ctx, year, month);
  }

  @Query()
  @Allow(Permission.ReadOrder)
  async topProducts(
    @Ctx() ctx: RequestContext,
    @Args('startDate') startDate: string,
    @Args('endDate') endDate: string,
    @Args('limit') limit = 20,
    @Args('sortBy') sortBy: 'quantity' | 'amount' = 'quantity',
  ) {
    return this.reportService.topProducts(ctx, startDate, endDate, limit, sortBy);
  }
}
