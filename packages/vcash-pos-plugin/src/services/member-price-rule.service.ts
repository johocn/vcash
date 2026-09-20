import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { RequestContext, UserInputError } from '@vendure/core';
import { Connection } from 'typeorm';

import {
  MemberPriceRule,
  MemberPriceRuleScope,
} from '../entities/member-price-rule.entity';

export interface MemberPriceRuleInput {
  scope: MemberPriceRuleScope;
  categoryId?: number | null;
  memberLevel: number;
  discountPercent: number;
  active?: boolean;
  priority?: number;
}

/**
 * 会员价规则服务：
 * - 提供 CRUD（admin 管理）
 * - 提供 findEffectiveRule：按 channel + memberLevel + category 查询生效规则
 *   优先级：category > global（priority 字段大的优先）
 */
@Injectable()
export class MemberPriceRuleService {
  constructor(@InjectConnection() private connection: Connection) {}

  async findAll(ctx: RequestContext, channelId?: number): Promise<MemberPriceRule[]> {
    const qb = this.connection
      .getRepository(MemberPriceRule)
      .createQueryBuilder('rule')
      .where('rule.channelId = :channelId', { channelId: channelId ?? ctx.channelId });
    return qb.orderBy('rule.memberLevel', 'ASC').addOrderBy('rule.priority', 'DESC').getMany();
  }

  async findOne(id: number): Promise<MemberPriceRule | null> {
    return this.connection.getRepository(MemberPriceRule).findOne({ where: { id } });
  }

  async create(ctx: RequestContext, input: MemberPriceRuleInput): Promise<MemberPriceRule> {
    this.validateInput(input);
    const rule = new MemberPriceRule();
    rule.channelId = ctx.channelId as number;
    rule.scope = input.scope;
    rule.categoryId = input.scope === 'category' ? (input.categoryId ?? null) : null;
    rule.memberLevel = input.memberLevel;
    rule.discountPercent = input.discountPercent;
    rule.active = input.active ?? true;
    rule.priority = input.priority ?? (input.scope === 'category' ? 100 : 10);
    return this.connection.getRepository(MemberPriceRule).save(rule);
  }

  async update(id: number, input: Partial<MemberPriceRuleInput>): Promise<MemberPriceRule> {
    const rule = await this.findOne(id);
    if (!rule) throw new UserInputError(`会员价规则 ${id} 不存在`);
    if (input.scope !== undefined) rule.scope = input.scope;
    if (input.categoryId !== undefined) rule.categoryId = input.categoryId ?? null;
    if (input.memberLevel !== undefined) rule.memberLevel = input.memberLevel;
    if (input.discountPercent !== undefined) rule.discountPercent = input.discountPercent;
    if (input.active !== undefined) rule.active = input.active;
    if (input.priority !== undefined) rule.priority = input.priority;
    this.validateInput(rule);
    return this.connection.getRepository(MemberPriceRule).save(rule);
  }

  async delete(id: number): Promise<boolean> {
    const res = await this.connection.getRepository(MemberPriceRule).delete(id);
    return (res.affected ?? 0) > 0;
  }

  /**
   * 查询生效规则：先查 category（指定 categoryId + memberLevel），未命中则查 global。
   * 若同一层有多条规则，priority 大者优先；priority 相同取 discountPercent 更低（更优惠）。
   */
  async findEffectiveRule(
    ctx: RequestContext,
    memberLevel: number,
    categoryId?: number | null,
  ): Promise<MemberPriceRule | null> {
    const channelId = ctx.channelId as number;
    const repo = this.connection.getRepository(MemberPriceRule);

    // 1. category 规则（仅当提供 categoryId）
    if (categoryId != null) {
      const catRule = await repo
        .createQueryBuilder('rule')
        .where('rule.channelId = :channelId', { channelId })
        .andWhere('rule.scope = :scope', { scope: 'category' })
        .andWhere('rule.categoryId = :categoryId', { categoryId })
        .andWhere('rule.memberLevel = :memberLevel', { memberLevel })
        .andWhere('rule.active = :active', { active: true })
        .orderBy('rule.priority', 'DESC')
        .addOrderBy('rule.discountPercent', 'ASC')
        .getOne();
      if (catRule) return catRule;
    }

    // 2. global 规则
    return repo
      .createQueryBuilder('rule')
      .where('rule.channelId = :channelId', { channelId })
      .andWhere('rule.scope = :scope', { scope: 'global' })
      .andWhere('rule.memberLevel = :memberLevel', { memberLevel })
      .andWhere('rule.active = :active', { active: true })
      .orderBy('rule.priority', 'DESC')
      .addOrderBy('rule.discountPercent', 'ASC')
      .getOne();
  }

  private validateInput(input: MemberPriceRuleInput | MemberPriceRule): void {
    if (input.memberLevel < 1 || input.memberLevel > 5) {
      throw new UserInputError('memberLevel 必须为 1-5');
    }
    if (input.discountPercent < 1 || input.discountPercent > 100) {
      throw new UserInputError('discountPercent 必须为 1-100');
    }
    if (input.scope === 'category' && (input as MemberPriceRuleInput).categoryId == null) {
      throw new UserInputError('scope=category 时必须提供 categoryId');
    }
  }
}
