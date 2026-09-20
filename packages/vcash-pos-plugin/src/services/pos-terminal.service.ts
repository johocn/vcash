import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { UserInputError } from '@vendure/core';
import { Connection } from 'typeorm';

import { PosTerminal, PosDeviceConfig } from '../entities/pos-terminal.entity';

@Injectable()
export class PosTerminalService {
  constructor(@InjectConnection() private connection: Connection) {}

  async findAll(channelId?: number): Promise<PosTerminal[]> {
    const qb = this.connection
      .getRepository(PosTerminal)
      .createQueryBuilder('terminal')
      .leftJoinAndSelect('terminal.channel', 'channel')
      .leftJoinAndSelect('terminal.stockLocation', 'stockLocation');
    if (channelId) {
      qb.where('channel.id = :channelId', { channelId });
    }
    return qb.getMany();
  }

  async findOne(id: number): Promise<PosTerminal | null> {
    return this.connection.getRepository(PosTerminal).findOne({
      where: { id },
      relations: ['channel', 'stockLocation'],
    });
  }

  async findByCode(code: string): Promise<PosTerminal | null> {
    return this.connection.getRepository(PosTerminal).findOne({
      where: { code },
      relations: ['channel', 'stockLocation'],
    });
  }

  async create(input: {
    code: string;
    name: string;
    channelId: number;
    stockLocationId: number;
    deviceConfig?: PosDeviceConfig | null;
  }): Promise<PosTerminal> {
    const existing = await this.findByCode(input.code);
    if (existing) {
      throw new UserInputError(`终端编号 ${input.code} 已存在`);
    }
    const terminal = new PosTerminal();
    terminal.code = input.code;
    terminal.name = input.name;
    terminal.channel = { id: input.channelId } as any;
    terminal.stockLocation = { id: input.stockLocationId } as any;
    terminal.active = true;
    terminal.deviceConfig = input.deviceConfig ?? null;
    const saved = await this.connection.getRepository(PosTerminal).save(terminal);
    const reloaded = await this.findOne(saved.id);
    if (!reloaded) throw new Error(`终端 ${saved.id} 创建后查询失败`);
    return reloaded;
  }

  async update(id: number, input: {
    name?: string;
    stockLocationId?: number;
    active?: boolean;
    deviceConfig?: PosDeviceConfig | null;
  }): Promise<PosTerminal> {
    const terminal = await this.findOne(id);
    if (!terminal) throw new UserInputError(`终端 ${id} 不存在`);
    if (input.name !== undefined) terminal.name = input.name;
    if (input.stockLocationId !== undefined) {
      terminal.stockLocation = { id: input.stockLocationId } as any;
    }
    if (input.active !== undefined) terminal.active = input.active;
    if (input.deviceConfig !== undefined) terminal.deviceConfig = input.deviceConfig;
    await this.connection.getRepository(PosTerminal).save(terminal);
    const reloaded = await this.findOne(id);
    if (!reloaded) throw new Error(`终端 ${id} 更新后查询失败`);
    return reloaded;
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.connection.getRepository(PosTerminal).delete(id);
    return (result.affected ?? 0) > 0;
  }
}
