import { Inject } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  Allow,
  Ctx,
  Permission,
  RequestContext,
  UserInputError,
} from '@vendure/core';

import { posTerminalPermission } from '../constants';
import { PosTerminal } from '../entities/pos-terminal.entity';
import { PosTerminalService } from '../services/pos-terminal.service';

@Resolver()
export class AdminTerminalResolver {
  constructor(@Inject(PosTerminalService) private terminalService: PosTerminalService) {}

  @Query()
  @Allow(Permission.ReadSettings, posTerminalPermission.Read)
  async posTerminals(
    @Ctx() ctx: RequestContext,
    @Args('channelId') channelId?: string,
  ): Promise<PosTerminal[]> {
    return this.terminalService.findAll(channelId ? parseInt(channelId, 10) : undefined);
  }

  @Query()
  @Allow(Permission.ReadSettings, posTerminalPermission.Read)
  async posTerminal(@Args('id') id: string): Promise<PosTerminal | null> {
    return this.terminalService.findOne(parseInt(id, 10));
  }

  @Mutation()
  @Allow(Permission.CreateSettings, posTerminalPermission.Create)
  async createPosTerminal(
    @Args('input') input: any,
    @Ctx() ctx: RequestContext,
  ): Promise<PosTerminal> {
    return this.terminalService.create({
      code: input.code,
      name: input.name,
      channelId: Number(ctx.channelId),
      stockLocationId: parseInt(input.stockLocationId, 10),
      deviceConfig: input.deviceConfig ?? null,
    });
  }

  @Mutation()
  @Allow(Permission.UpdateSettings, posTerminalPermission.Update)
  async updatePosTerminal(@Args('input') input: any): Promise<PosTerminal> {
    return this.terminalService.update(parseInt(input.id, 10), {
      name: input.name,
      stockLocationId: input.stockLocationId ? parseInt(input.stockLocationId, 10) : undefined,
      active: input.active,
      deviceConfig: input.deviceConfig,
    });
  }

  @Mutation()
  @Allow(Permission.DeleteSettings, posTerminalPermission.Delete)
  async deletePosTerminal(@Args('id') id: string): Promise<boolean> {
    const ok = await this.terminalService.delete(parseInt(id, 10));
    if (!ok) throw new UserInputError(`终端 ${id} 不存在`);
    return true;
  }
}
