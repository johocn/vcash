import { CrudPermissionDefinition } from '@vendure/core';

export const POS_PERMISSIONS = {
  TERMINAL_READ: 'PosTerminal.Read',
  TERMINAL_CREATE: 'PosTerminal.Create',
  TERMINAL_UPDATE: 'PosTerminal.Update',
  TERMINAL_DELETE: 'PosTerminal.Delete',
  SESSION_READ: 'PosSession.Read',
  SESSION_OPEN: 'PosSession.Open',
  SESSION_CLOSE: 'PosSession.Close',
  SESSION_APPROVE: 'PosSession.Approve',
  ORDER_ADD_ITEM: 'PosOrder.AddItem',
  ORDER_CHECKOUT: 'PosOrder.Checkout',
  ORDER_REFUND: 'Order.Refund.Create',
  PRODUCT_READ: 'PosProduct.Read',
  MEMBER_READ: 'PosMember.Read',
  ORDER_SYNC: 'PosOrder.Sync',
} as const;

/**
 * PosTerminal CRUD 权限定义（用于 @Allow 装饰器与 authOptions.customPermissions 注册）。
 * 生成 CreatePosTerminal / ReadPosTerminal / UpdatePosTerminal / DeletePosTerminal 四个权限。
 */
export const posTerminalPermission = new CrudPermissionDefinition('PosTerminal');

/**
 * PosSession CRUD 权限定义。Create/Update 对应开班/关班动作。
 */
export const posSessionPermission = new CrudPermissionDefinition('PosSession');


export const POS_SESSION_STATE = {
  OPEN: 'open',
  CLOSED: 'closed',
} as const;

export const ORDER_TYPE = {
  SALE: 'sale',
  REFUND: 'refund',
  HOLD: 'hold',
} as const;

export const AGGREGATE_PAY_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  SETTLED: 'settled',
  FAILED: 'failed',
  REFUNDED: 'refunded',
} as const;
