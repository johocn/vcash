import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 促销规则类型：
 * - fullReduction: 满减（满 X 减 Y，可阶梯）
 * - discount: 整单折扣（X 折）
 * - buyGift: 买赠（买 N 送 M）
 */
export type PromotionType = 'fullReduction' | 'discount' | 'buyGift';

/**
 * 作用域：
 * - global: 全局生效
 * - collection: 仅对指定 collection 内商品生效（buyGift 用 buyVariantId 判定，scope=collection 时额外校验 buyVariantId 属于该 collection）
 */
export type PromotionScope = 'global' | 'collection';

@Entity()
export class PromotionRule {
  @PrimaryGeneratedColumn() id!: number;

  @Index()
  @Column({ type: 'int' }) channelId!: number;

  @Column({ type: 'varchar' }) type!: PromotionType;

  @Column({ type: 'varchar' }) name!: string;

  @Column({ type: 'text', nullable: true }) description: string | null = null;

  @Column({ type: 'varchar' }) scope!: PromotionScope;

  @Column({ type: 'int', nullable: true }) collectionId: number | null = null;

  /**
   * 全局唯一优先级，数字大者优先；同 saving 取 priority 大者。
   */
  @Column({ type: 'int', default: 10 }) priority: number = 10;

  @Column({ type: 'boolean', default: true }) active: boolean = true;

  @Column({ type: 'datetime', nullable: true }) startTime: Date | null = null;

  @Column({ type: 'datetime', nullable: true }) endTime: Date | null = null;

  /**
   * 按 type 不同（JSON 字符串）：
   * - fullReduction: { tiers: [{ threshold, reduction }, ...] }
   * - discount: { minOrderValue?: number }
   * - buyGift: { buyVariantId, buyQuantity }
   */
  @Column({ type: 'json', nullable: true }) conditions: any | null = null;

  /**
   * 按 type 不同（JSON 字符串）：
   * - fullReduction: null（reduction 写在 conditions.tiers）
   * - discount: { discountPercent: number }
   * - buyGift: { giftVariantId, giftQuantity }
   */
  @Column({ type: 'json', nullable: true }) actions: any | null = null;

  @CreateDateColumn({ type: 'datetime' }) createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' }) updatedAt!: Date;
}
