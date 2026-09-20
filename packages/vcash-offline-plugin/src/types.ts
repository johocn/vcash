export interface OfflineOrderLineRecord {
  productVariantId: string;
  quantity: number;
  discount?: number;
  isGift?: boolean;
  note?: string;
  originalPrice?: number;
}

export interface OfflinePaymentRecord {
  method: string;
  transactionId?: string;
  metadata?: any;
}

export interface OfflineOrderRecord {
  idempotencyKey: string;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  sessionCode: string;
  terminalCode: string;
  orderType: string;
  lines: OfflineOrderLineRecord[];
  payments: OfflinePaymentRecord[];
  totalAmount: number;
}

export interface SyncedOrderResult {
  idempotencyKey: string;
  orderId: number;
  orderCode: string;
  status: 'success' | 'duplicate';
}

export interface SyncFailureResult {
  idempotencyKey: string;
  error: string;
  code: string;
  status: 'failed';
}

/**
 * 离线 Payment 同步记录（独立于订单的支付补录场景）。
 * - idempotencyKey: 该笔 payment 自身的幂等键
 * - orderKey: 关联订单的 idempotencyKey（用于查找已同步的 Order）
 */
export interface OfflinePaymentSyncRecord {
  idempotencyKey: string;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  orderKey: string;
  method: string;
  amount: number;
  transactionId?: string;
  metadata?: any;
}

export interface SyncedPaymentResult {
  idempotencyKey: string;
  paymentId: number;
  orderId: number;
  status: 'success' | 'duplicate';
}

export interface SyncPaymentFailureResult {
  idempotencyKey: string;
  error: string;
  code: string;
  status: 'failed';
}

/**
 * 离线 PosSession 同步记录。
 * - state='open' 仅开班；state='closed' 开班后立即关班（带 closingCash）
 * - sessionCode 由客户端生成（用于关联已同步的 Orders）
 */
export interface OfflineSessionRecord {
  idempotencyKey: string;
  clientCreatedAt: string;
  clientUpdatedAt: string;
  sessionCode: string;
  terminalCode: string;
  operatorId: number;
  openingFloat: number;
  state: 'open' | 'closed';
  closingCash?: number;
}

export interface SyncedSessionResult {
  idempotencyKey: string;
  sessionId: number;
  sessionCode: string;
  state: 'open' | 'closed';
  status: 'success' | 'duplicate';
}

export interface SyncSessionFailureResult {
  idempotencyKey: string;
  error: string;
  code: string;
  status: 'failed';
}

export interface ProductSnapshot {
  variantId: number;
  sku: string;
  name: string;
  price: number;
  priceWithTax: number;
  barcode: string | null;
  categoryId: number | null;
  updatedAt: Date;
}

export interface MemberSnapshot {
  customerId: number;
  emailAddress: string;
  firstName: string;
  lastName: string;
  customFields: {
    memberLevel: number;
    points: number;
  };
  updatedAt: Date;
}

export interface SyncProductsResult {
  items: ProductSnapshot[];
  cursor: Date;
}

export interface SyncMembersResult {
  items: MemberSnapshot[];
  cursor: Date;
}
