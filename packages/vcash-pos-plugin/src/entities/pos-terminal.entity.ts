import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel, StockLocation } from '@vendure/core';

export type PosDeviceConfig = {
  printerVendorId?: string;
  printerProductId?: string;
  scaleBaudRate?: number;
  scaleProtocol?: 'continuous' | 'polling';
  cashDrawerViaPrinter?: boolean;
  paperWidth?: 58 | 80;
};

@Entity()
export class PosTerminal {
  @PrimaryGeneratedColumn() id!: number;

  // 显式声明 column type，避免依赖 emitDecoratorMetadata（vitest/esbuild 不输出 design:type）
  @Column({ type: 'varchar', unique: true }) code!: string;

  @Column({ type: 'varchar' }) name!: string;

  @Index()
  @ManyToOne(() => Channel)
  channel!: Channel;

  @ManyToOne(() => StockLocation)
  stockLocation!: StockLocation;

  @Column({ type: 'boolean', default: true }) active!: boolean;

  @CreateDateColumn({ type: 'datetime' }) createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' }) updatedAt!: Date;

  @Column({ type: 'json', nullable: true })
  deviceConfig: PosDeviceConfig | null = null;
}
