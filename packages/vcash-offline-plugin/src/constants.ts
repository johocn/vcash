import { CrudPermissionDefinition } from '@vendure/core';

export const SYNC_STATUS = {
  PENDING: 'pending',
  SYNCING: 'syncing',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  NEEDS_MANUAL: 'needs_manual',
} as const;

export const SYNC_TYPE = {
  ORDER: 'order',
  PAYMENT: 'payment',
  SESSION: 'session',
} as const;

export const offlineSyncPermission = new CrudPermissionDefinition('OfflineSync');
