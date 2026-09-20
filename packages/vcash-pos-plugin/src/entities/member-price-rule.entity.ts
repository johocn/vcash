import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 会员价规则作用域：
 * - global：按 memberLevel 全局生效
 * - category：按 memberLevel + categoryId 生效，priority 高于 global
 */
export type MemberPriceRuleScope = 'global' | 'category';

@Entity()
export class MemberPriceRule {
  @PrimaryGeneratedColumn() id!: number;

  @Index()
  @Column({ type: 'int' }) channelId!: number;

  @Column({ type: 'varchar' }) scope!: MemberPriceRuleScope;

  /**
   * 仅 scope='category' 时使用；scope='global' 时为 null。
   */
  @Column({ type: 'int', nullable: true }) categoryId: number | null = null;

  /**
   * 会员等级 1-5，对应 member-level-plugin 的 memberLevel。
   */
  @Column({ type: 'int' }) memberLevel!: number;

  /**
   * 折扣百分比（整数 95 = 95 折）。范围 1-100。
   */
  @Column({ type: 'int' }) discountPercent!: number;

  @Column({ type: 'boolean', default: true }) active: boolean = true;

  /**
   * 优先级：category 默认 100，global 默认 10；数字大者优先。
   */
  @Column({ type: 'int', default: 10 }) priority: number = 10;

  @CreateDateColumn({ type: 'datetime' }) createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' }) updatedAt!: Date;
}
