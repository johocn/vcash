import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Customer, ProductVariant, RequestContext, TransactionalConnection } from '@vendure/core';
import { Connection } from 'typeorm';

import { MemberPriceRule } from '../entities/member-price-rule.entity';
import { MemberPriceRuleService } from './member-price-rule.service';

/**
 * 会员价计算结果：
 * - discountPercent: 1-100（95=95折），无规则时为 100（原价）
 * - applied: 是否应用了会员价（discountPercent < 100）
 * - ruleId: 命中的规则 ID（便于追溯，未命中为 null）
 */
export interface MemberPriceCalcResult {
  discountPercent: number;
  applied: boolean;
  ruleId: number | null;
}

/**
 * 会员价计算引擎：
 * 1. 读取 customer.customFields.memberLevel
 * 2. 查 ProductVariant → Product → 主分类（product_product_category 第一个 categoryId）
 * 3. 调 MemberPriceRuleService.findEffectiveRule(level, categoryId) 命中规则
 * 4. 返回 discountPercent 与 applied 标志
 *
 * 设计原则：纯查询计算，不修改 order/orderLine（由调用方应用结果）
 */
@Injectable()
export class MemberPriceCalculator {
  constructor(
    @InjectConnection() private connection: Connection,
    @Inject(TransactionalConnection) private transactionalConnection: TransactionalConnection,
    @Inject(MemberPriceRuleService) private ruleService: MemberPriceRuleService,
  ) {}

  /**
   * 计算指定会员 + 商品变体的会员价折扣。
   * 若 customer 为 null / 无 memberLevel / 无匹配规则，返回 discountPercent=100, applied=false。
   */
  async calculate(
    ctx: RequestContext,
    customer: Customer | { id: number; customFields?: any } | null,
    variantId: number,
  ): Promise<MemberPriceCalcResult> {
    if (!customer) return { discountPercent: 100, applied: false, ruleId: null };

    // customer 可能是轻量对象（仅 id）；如果 customFields 缺失则查库
    let memberLevel: number | undefined = (customer as any).customFields?.memberLevel;
    if (memberLevel == null) {
      const full = await this.connection.getRepository(Customer).findOne({
        where: { id: customer.id },
      });
      memberLevel = (full as any)?.customFields?.memberLevel ?? 1;
    }
    if (!memberLevel || memberLevel < 1) {
      return { discountPercent: 100, applied: false, ruleId: null };
    }

    const categoryId = await this.resolveVariantCategoryId(variantId);
    const rule: MemberPriceRule | null = await this.ruleService.findEffectiveRule(
      ctx,
      memberLevel,
      categoryId,
    );
    if (!rule) return { discountPercent: 100, applied: false, ruleId: null };

    return {
      discountPercent: rule.discountPercent,
      applied: rule.discountPercent < 100,
      ruleId: rule.id,
    };
  }

  /**
   * 解析 ProductVariant → 主分类 ID（取 ProductVariant.collections 关联的第一个 Collection）。
   * Vendure 中"分类"由 Collection 实体表达（ProductVariant.collections ManyToMany）。
   * 无 Collection 返回 null（findEffectiveRule 会回退到 global 规则）。
   */
  private async resolveVariantCategoryId(variantId: number): Promise<number | null> {
    const variant = await this.connection.getRepository(ProductVariant).findOne({
      where: { id: variantId },
      relations: ['collections'],
    });
    const collections = (variant as any)?.collections ?? [];
    return collections.length > 0 ? Number(collections[0].id) : null;
  }
}
