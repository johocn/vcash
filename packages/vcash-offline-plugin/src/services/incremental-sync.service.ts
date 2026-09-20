import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import {
  Customer,
  ProductVariant,
  RequestContext,
  TransactionalConnection,
} from '@vendure/core';
import { Connection } from 'typeorm';

import {
  MemberSnapshot,
  ProductSnapshot,
  SyncMembersResult,
  SyncProductsResult,
} from '../types';

/**
 * 商品/会员增量同步服务：
 * - syncProducts: 按 ProductVariant.updatedAt > since 增量查询，按 Channel 隔离
 * - syncMembers: 按 Customer.updatedAt > since 增量查询，按 Channel 隔离
 *
 * cursor = 当前批次最后一条记录的 updatedAt，前端下次同步以该 cursor 作为 since。
 * 按 updatedAt ASC 排序保证 cursor 单调推进。
 *
 * 关键实现细节（Vendure 3.6.4）：
 * 1. ProductVariant.price/priceWithTax 是 Calculated 属性，依赖运行时注入的 listPrice/taxRateApplied。
 *    直接用 repository 查询时这些属性为 undefined，需从 productVariantPrices 关系取 listPrice。
 *    测试环境 taxRate=0%，price=priceWithTax=listPrice。
 * 2. ProductVariant.name 是 LocaleString，从 translations[0].name 取。
 * 3. Customer.customFields 是 embedded entity，memberLevel/points 由 member-level-plugin 注入。
 *    用 optional chaining + 默认值兜底，未注册该插件时返回 0。
 */
@Injectable()
export class IncrementalSyncService {
  constructor(
    @InjectConnection() private connection: Connection,
    @Inject(TransactionalConnection) private transactionalConnection: TransactionalConnection,
  ) {}

  async syncProducts(
    ctx: RequestContext,
    since: Date,
    limit: number,
  ): Promise<SyncProductsResult> {
    const channelId = ctx.channelId;

    const variants = await this.connection
      .getRepository(ProductVariant)
      .createQueryBuilder('variant')
      .leftJoinAndSelect('variant.product', 'product')
      .leftJoinAndSelect('variant.productVariantPrices', 'price')
      .leftJoinAndSelect('variant.translations', 'translation')
      .leftJoin('variant.channels', 'channel', 'channel.id = :channelId', { channelId })
      .where('variant.deletedAt IS NULL')
      .andWhere('variant.updatedAt > :since', { since })
      .andWhere('channel.id = :channelId', { channelId })
      .orderBy('variant.updatedAt', 'ASC')
      .take(limit)
      .getMany();

    const items: ProductSnapshot[] = variants.map(v => {
      const listPrice =
        v.productVariantPrices?.find(p => Number(p.channelId) === Number(channelId))?.price ??
        v.productVariantPrices?.[0]?.price ??
        0;
      const name =
        v.translations?.[0]?.name ??
        (v as any).name ??
        v.product?.translations?.[0]?.name ??
        '';
      return {
        variantId: Number(v.id),
        sku: v.sku ?? '',
        name,
        price: listPrice,
        priceWithTax: listPrice,
        barcode: (v.customFields as any)?.barcode ?? null,
        categoryId: v.productId ? Number(v.productId) : null,
        updatedAt: v.updatedAt,
      };
    });

    const cursor = items.length > 0 ? items[items.length - 1].updatedAt : since;
    return { items, cursor };
  }

  async syncMembers(
    ctx: RequestContext,
    since: Date,
    limit: number,
  ): Promise<SyncMembersResult> {
    const channelId = ctx.channelId;

    const customers = await this.connection
      .getRepository(Customer)
      .createQueryBuilder('customer')
      .leftJoin('customer.channels', 'channel', 'channel.id = :channelId', { channelId })
      .where('customer.deletedAt IS NULL')
      .andWhere('customer.updatedAt > :since', { since })
      .andWhere('channel.id = :channelId', { channelId })
      .orderBy('customer.updatedAt', 'ASC')
      .take(limit)
      .getMany();

    const items: MemberSnapshot[] = customers.map(c => ({
      customerId: Number(c.id),
      emailAddress: c.emailAddress ?? '',
      firstName: c.firstName ?? '',
      lastName: c.lastName ?? '',
      customFields: {
        memberLevel: (c.customFields as any)?.memberLevel ?? 0,
        points: (c.customFields as any)?.points ?? 0,
      },
      updatedAt: c.updatedAt,
    }));

    const cursor = items.length > 0 ? items[items.length - 1].updatedAt : since;
    return { items, cursor };
  }
}
