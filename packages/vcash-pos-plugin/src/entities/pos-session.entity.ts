import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Administrator, Customer, StockLocation } from '@vendure/core';

import { PosTerminal } from './pos-terminal.entity';

/**
 * 班次状态：open=开班中，closed=已关班
 */
export type PosSessionState = 'open' | 'closed';

/**
 * 关班时生成的对账单快照（由 ShiftReportService 在 Task 6 生成，此处先用 any 兜底）
 */
export type ShiftSummary = {
  orders: {
    totalCount: number;
    totalAmount: number;
    normalCount: number;
    refundCount: number;
    refundAmount: number;
    heldCount: number;
  };
  paymentsByMethod: Array<{ method: string; count: number; amount: number }>;
  warnings: string[];
};

@Entity()
export class PosSession {
  @PrimaryGeneratedColumn() id!: number;

  // 班次号 "S20260801-001"
  @Column({ type: 'varchar', unique: true }) code!: string;

  @Index()
  @ManyToOne(() => PosTerminal)
  terminal!: PosTerminal;

  @ManyToOne(() => StockLocation)
  stockLocation!: StockLocation;

  @ManyToOne(() => Administrator)
  operator!: Administrator;

  @ManyToOne(() => Administrator, { nullable: true })
  approver: Administrator | null = null;

  // 简化两态：open / closed
  @Column({ type: 'varchar', default: 'open' })
  state: PosSessionState = 'open';

  @CreateDateColumn({ type: 'datetime' }) openedAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  closedAt: Date | null = null;

  @Column({ type: 'json', nullable: true })
  closeSummary: ShiftSummary | null = null;

  // 备用金（分）
  @Column({ type: 'int', default: 0 }) openingFloat: number = 0;

  // 实交现金（分）
  @Column({ type: 'int', default: 0 }) closingCash: number = 0;

  // 当前活跃 Draft Order ID
  @Column({ type: 'int', nullable: true })
  activeOrderId: number | null = null;

  /**
   * 当前绑定的会员 ID（可空，未绑定会员时为 null）。
   * POS 收银员通过会员识别 API 绑定，加购时自动应用会员价。
   */
  @Index()
  @Column({ type: 'int', nullable: true })
  customerId: number | null = null;

  @ManyToOne(() => Customer, { nullable: true })
  customer: Customer | null = null;

  @UpdateDateColumn({ type: 'datetime' }) updatedAt!: Date;
}
