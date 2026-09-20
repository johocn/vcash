import { TypeOrmModule } from '@nestjs/typeorm';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { VcashPosPlugin } from '@vcash/pos-plugin';
import gql from 'graphql-tag';

import { offlineSyncPermission } from './constants';
import { OfflineSyncQueue } from './entities/offline-sync-queue.entity';
import { AdminSyncResolver } from './resolvers/admin-sync.resolver';
import { IncrementalSyncService } from './services/incremental-sync.service';
import { OfflineSyncQueueService } from './services/sync-queue.service';
import { SyncOrderService } from './services/sync-order.service';
import { SyncPaymentService } from './services/sync-payment.service';
import { SyncSessionService } from './services/sync-session.service';

const adminSchema = gql`
  input SyncOrdersInput {
    orders: [OfflineOrderInput!]!
  }

  input OfflineOrderInput {
    idempotencyKey: String!
    clientCreatedAt: DateTime!
    clientUpdatedAt: DateTime!
    sessionCode: String!
    terminalCode: String!
    orderType: String!
    lines: [OfflineOrderLineInput!]!
    payments: [OfflinePaymentInput!]!
    totalAmount: Int!
  }

  input OfflineOrderLineInput {
    productVariantId: ID!
    quantity: Int!
    discount: Int
    isGift: Boolean
    note: String
    originalPrice: Int
  }

  input OfflinePaymentInput {
    method: String!
    transactionId: String
    metadata: JSON
  }

  type SyncOrdersResult {
    succeeded: [SyncedOrder!]!
    failed: [SyncFailure!]!
  }

  type SyncedOrder {
    idempotencyKey: String!
    orderId: ID!
    orderCode: String!
    status: String!
  }

  type SyncFailure {
    idempotencyKey: String!
    error: String!
    code: String!
    status: String!
  }

  # ===== syncPayments =====
  input SyncPaymentsInput {
    payments: [OfflinePaymentSyncInput!]!
  }

  input OfflinePaymentSyncInput {
    idempotencyKey: String!
    clientCreatedAt: DateTime!
    clientUpdatedAt: DateTime!
    orderKey: String!
    method: String!
    amount: Int!
    transactionId: String
    metadata: JSON
  }

  type SyncPaymentsResult {
    succeeded: [SyncedPayment!]!
    failed: [SyncPaymentFailure!]!
  }

  type SyncedPayment {
    idempotencyKey: String!
    paymentId: ID!
    orderId: ID!
    status: String!
  }

  type SyncPaymentFailure {
    idempotencyKey: String!
    error: String!
    code: String!
    status: String!
  }

  # ===== syncSessions =====
  input SyncSessionsInput {
    sessions: [OfflineSessionInput!]!
  }

  input OfflineSessionInput {
    idempotencyKey: String!
    clientCreatedAt: DateTime!
    clientUpdatedAt: DateTime!
    sessionCode: String!
    terminalCode: String!
    operatorId: ID!
    openingFloat: Int!
    state: String!
    closingCash: Int
  }

  type SyncSessionsResult {
    succeeded: [SyncedSession!]!
    failed: [SyncSessionFailure!]!
  }

  type SyncedSession {
    idempotencyKey: String!
    sessionId: ID!
    sessionCode: String!
    state: String!
    status: String!
  }

  type SyncSessionFailure {
    idempotencyKey: String!
    error: String!
    code: String!
    status: String!
  }

  # ===== 增量同步 syncProducts / syncMembers =====
  type SyncProductsResult {
    items: [ProductSnapshot!]!
    cursor: DateTime!
  }

  type ProductSnapshot {
    variantId: ID!
    sku: String!
    name: String!
    price: Int!
    priceWithTax: Int!
    barcode: String
    categoryId: ID
    updatedAt: DateTime!
  }

  type SyncMembersResult {
    items: [MemberSnapshot!]!
    cursor: DateTime!
  }

  type MemberSnapshot {
    customerId: ID!
    emailAddress: String!
    firstName: String!
    lastName: String!
    customFields: MemberCustomFieldsSnapshot!
    updatedAt: DateTime!
  }

  type MemberCustomFieldsSnapshot {
    memberLevel: Int!
    points: Int!
  }

  extend type Mutation {
    syncOrders(input: SyncOrdersInput!): SyncOrdersResult!
    syncPayments(input: SyncPaymentsInput!): SyncPaymentsResult!
    syncSessions(input: SyncSessionsInput!): SyncSessionsResult!
  }

  extend type Query {
    syncProducts(since: DateTime!, limit: Int!): SyncProductsResult!
    syncMembers(since: DateTime!, limit: Int!): SyncMembersResult!
  }
`;

@VendurePlugin({
  imports: [PluginCommonModule, TypeOrmModule.forFeature([OfflineSyncQueue]), VcashPosPlugin],
  entities: [OfflineSyncQueue],
  providers: [
    OfflineSyncQueueService,
    SyncOrderService,
    SyncPaymentService,
    SyncSessionService,
    IncrementalSyncService,
  ],
  adminApiExtensions: {
    resolvers: [AdminSyncResolver],
    schema: adminSchema,
  },
  configuration: (config) => {
    config.authOptions.customPermissions = [
      ...(config.authOptions.customPermissions ?? []),
      offlineSyncPermission,
    ];
    return config;
  },
})
export class VcashOfflinePlugin {}
