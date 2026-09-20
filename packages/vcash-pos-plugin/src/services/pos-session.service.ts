import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { UserInputError } from '@vendure/core';
import { Connection, Like } from 'typeorm';

import { PosSession, ShiftSummary } from '../entities/pos-session.entity';
import { PosTerminalService } from './pos-terminal.service';
import { ShiftReportService } from './shift-report.service';

/**
 * 班次生命周期服务：
 * - 开班：校验终端 active + 无 open session → 生成 session code → 持久化
 * - 关班：校验 session open → 调用 ShiftReportService 生成 closeSummary → 标记 closed
 * - 查询：findOpenSession / findMySession / findOne
 *
 * closeSession 若未显式传入 closeSummary，则调用 ShiftReportService 自动生成。
 */
@Injectable()
export class PosSessionService {
  constructor(
    @InjectConnection() private connection: Connection,
    @Inject(PosTerminalService) private terminalService: PosTerminalService,
    @Inject(ShiftReportService) private shiftReportService: ShiftReportService,
  ) {}

  /**
   * 开班。同一终端同时仅允许一个 open 状态 session。
   */
  async openSession(input: {
    terminalCode: string;
    operatorId: number;
    openingFloat?: number;
  }): Promise<PosSession> {
    const terminal = await this.terminalService.findByCode(input.terminalCode);
    if (!terminal) {
      throw new UserInputError(`终端 ${input.terminalCode} 不存在`);
    }
    if (!terminal.active) {
      throw new UserInputError(`终端 ${input.terminalCode} 已停用`);
    }

    const existing = await this.findOpenSession(terminal.id);
    if (existing) {
      throw new UserInputError(
        `终端 ${input.terminalCode} 已有开着的班次 ${existing.code}`,
      );
    }

    const code = await this.generateSessionCode();

    const session = new PosSession();
    session.code = code;
    session.terminal = terminal;
    session.stockLocation = terminal.stockLocation;
    session.operator = { id: input.operatorId } as any;
    session.state = 'open';
    session.openingFloat = input.openingFloat ?? 0;
    session.activeOrderId = null;

    const saved = await this.connection.getRepository(PosSession).save(session);
    const reloaded = await this.findOne(saved.id);
    if (!reloaded) {
      throw new Error(`班次 ${saved.id} 创建后查询失败`);
    }
    return reloaded;
  }

  /**
   * 关班。若未显式传入 closeSummary，则调用 ShiftReportService 自动生成
   * （会基于 closingCash 进行现金对账并产出 warnings）。
   */
  async closeSession(input: {
    sessionId: number;
    closingCash?: number;
    approverId?: number;
    closeSummary?: ShiftSummary | null;
  }): Promise<PosSession> {
    const session = await this.findOne(input.sessionId);
    if (!session) {
      throw new UserInputError(`班次 ${input.sessionId} 不存在`);
    }
    if (session.state !== 'open') {
      throw new UserInputError(`班次 ${session.code} 已关闭`);
    }

    const closingCash = input.closingCash ?? 0;
    // 未传 closeSummary 时自动生成（传入 closingCash 触发现金对账）
    const summary =
      input.closeSummary !== undefined
        ? input.closeSummary
        : await this.shiftReportService.generateSummary(
            input.sessionId,
            closingCash,
          );

    session.state = 'closed';
    session.closedAt = new Date();
    session.closingCash = closingCash;
    session.closeSummary = summary;
    if (input.approverId) {
      session.approver = { id: input.approverId } as any;
    }
    session.activeOrderId = null;

    return this.connection.getRepository(PosSession).save(session);
  }

  async findOpenSession(terminalId: number): Promise<PosSession | null> {
    return this.connection.getRepository(PosSession).findOne({
      where: { terminal: { id: terminalId }, state: 'open' },
      relations: ['terminal', 'operator', 'stockLocation', 'customer'],
    });
  }

  async findMyOpenSession(operatorId: number): Promise<PosSession | null> {
    return this.connection.getRepository(PosSession).findOne({
      where: { operator: { id: operatorId }, state: 'open' },
      relations: ['terminal', 'operator', 'stockLocation', 'customer'],
    });
  }

  async findOne(id: number): Promise<PosSession | null> {
    return this.connection.getRepository(PosSession).findOne({
      where: { id },
      relations: ['terminal', 'operator', 'approver', 'stockLocation', 'customer'],
    });
  }

  /**
   * 保存 session 变更（绑定/解绑会员、activeOrderId 变更等）。
   */
  async save(session: PosSession): Promise<PosSession> {
    const saved = await this.connection.getRepository(PosSession).save(session);
    const reloaded = await this.findOne(saved.id);
    if (!reloaded) throw new Error(`班次 ${saved.id} 保存后查询失败`);
    return reloaded;
  }

  /**
   * 生成班次号：S{YYYYMMDD}-{3位序号}。序号按当天已有 session 数 +1 推算。
   */
  private async generateSessionCode(): Promise<string> {
    const dateStr = new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '');
    const prefix = `S${dateStr}-`;
    const count = await this.connection
      .getRepository(PosSession)
      .count({ where: { code: Like(`${prefix}%`) } });
    return `${prefix}${String(count + 1).padStart(3, '0')}`;
  }
}
