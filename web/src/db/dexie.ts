import Dexie, { type Table } from 'dexie';

/**
 * 离线同步状态机：
 * pending ──(队列触发)──► syncing ──(HTTP 成功)──► success
 *    │                       │
 *    │                       └── HTTP 失败/超时 ──► failed ──(指数退避 ≤ 5 次)──► pending
 *    │
 *    └── failed 超过 5 次 ──► needs_manual（人工处理）
 */
export type SyncStatus = 'pending' | 'syncing' | 'success' | 'failed' | 'needs_manual';

export interface OfflineOrderLine {
  productVariantId: string;
  quantity: number;
  discount?: number;
  isGift?: boolean;
  note?: string | null;
  originalPrice?: number;
}

/** 订单内嵌的支付引用（随 syncOrders 一并提交） */
export interface OfflinePaymentRef {
  method: string;
  transactionId?: string;
  metadata?: Record<string, unknown> | null;
}

/** orders 表记录：离线订单（含同步状态元数据） */
export interface OfflineOrderRecord {
  idempotencyKey: string;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  sessionCode: string;
  terminalCode: string;
  orderType: 'sale' | 'refund' | 'hold';
  refundedOrderKey?: string;
  lines: OfflineOrderLine[];
  payments: OfflinePaymentRef[];
  totalAmount: number;
  syncStatus: SyncStatus;
  syncError?: string;
  syncedOrderId?: number;
  syncedOrderCode?: string;
  retryCount?: number;
  /** 下次重试时间（ISO），failed 状态据此调度 */
  nextRetryAt?: string;
}

/** payments 表记录：独立同步的支付（用于 syncPayments 补录场景） */
export interface OfflinePaymentRecord {
  idempotencyKey: string;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  /** 关联订单的 idempotencyKey */
  orderKey: string;
  method: string;
  amount: number;
  transactionId?: string;
  metadata?: Record<string, unknown> | null;
  syncStatus: SyncStatus;
  syncError?: string;
  retryCount?: number;
  nextRetryAt?: string;
}

export interface ShiftSummary {
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
}

/** sessions 表记录：离线班次（关班时本地生成） */
export interface OfflineSessionRecord {
  /** PK，等于 sessionCode */
  code: string;
  idempotencyKey: string;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  terminalCode: string;
  operatorId?: number;
  state: 'open' | 'closed';
  openedAt: string;
  closedAt?: string;
  openingFloat: number;
  closingCash?: number;
  localSummary?: ShiftSummary;
  syncStatus: SyncStatus;
  syncError?: string;
  retryCount?: number;
}

/** products 表记录：商品快照（增量同步填充） */
export interface ProductSnapshot {
  /** PK */
  variantId: number;
  sku: string;
  name: string;
  price: number;
  priceWithTax: number;
  barcode: string | null;
  categoryId: number | null;
  updatedAt: string;
}

/** members 表记录：会员快照（增量同步填充） */
export interface MemberSnapshot {
  /** PK */
  customerId: number;
  emailAddress: string;
  firstName: string;
  lastName: string;
  memberLevel: number;
  points: number;
  updatedAt: string;
}

/** syncMeta 表记录：增量同步游标等元数据 */
export interface SyncMeta {
  /** PK，如 products_last_cursor / members_last_cursor */
  key: string;
  value: string;
  updatedAt?: string;
}

export class VcashDB extends Dexie {
  orders!: Table<OfflineOrderRecord, string>;
  payments!: Table<OfflinePaymentRecord, string>;
  sessions!: Table<OfflineSessionRecord, string>;
  products!: Table<ProductSnapshot, number>;
  members!: Table<MemberSnapshot, number>;
  syncMeta!: Table<SyncMeta, string>;

  constructor() {
    super('vcash-pos');
    // 索引按 spec §5.2。products 增加 sku/name 索引以支持离线搜索；
    // members 以 customerId 为 PK（后端 syncMembers 返回 customerId，无 mobile 字段）。
    this.version(1).stores({
      orders: 'idempotencyKey, sessionCode, clientCreatedAt, syncStatus',
      payments: 'idempotencyKey, orderKey, method, syncStatus',
      sessions: 'code, terminalCode, state, openedAt',
      products: 'variantId, barcode, sku, name, categoryId, updatedAt',
      members: 'customerId, emailAddress, updatedAt',
      syncMeta: 'key',
    });
  }
}

export const db = new VcashDB();
