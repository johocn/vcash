import { onMounted, onUnmounted } from 'vue';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';
import { db, type ProductSnapshot, type MemberSnapshot } from '@/db/dexie';

const SYNC_PRODUCTS = gql`
  query SyncProducts($since: DateTime!, $limit: Int!) {
    syncProducts(since: $since, limit: $limit) {
      items {
        variantId
        sku
        name
        price
        priceWithTax
        barcode
        categoryId
        updatedAt
      }
      cursor
    }
  }
`;

const SYNC_MEMBERS = gql`
  query SyncMembers($since: DateTime!, $limit: Int!) {
    syncMembers(since: $since, limit: $limit) {
      items {
        customerId
        emailAddress
        firstName
        lastName
        updatedAt
        customFields {
          memberLevel
          points
        }
      }
      cursor
    }
  }
`;

const SYNC_META_PRODUCTS_KEY = 'products_last_cursor';
const SYNC_META_MEMBERS_KEY = 'members_last_cursor';
const EPOCH = '1970-01-01T00:00:00Z';
const INTERVAL_MS = 5 * 60 * 1000;
const PAGE_LIMIT = 500;

async function getCursor(key: string): Promise<string> {
  const meta = await db.syncMeta.get(key);
  return meta?.value ?? EPOCH;
}

async function setCursor(key: string, value: string): Promise<void> {
  await db.syncMeta.put({
    key,
    value,
    updatedAt: new Date().toISOString(),
  });
}

/** 拉取商品增量直到无更多数据。cursor 推进存 syncMeta。 */
async function syncProducts(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  let cursor = await getCursor(SYNC_META_PRODUCTS_KEY);
  for (let i = 0; i < 50; i++) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    let result: any;
    try {
      const { data, errors } = await apolloClient.query({
        query: SYNC_PRODUCTS,
        variables: { since: cursor, limit: PAGE_LIMIT },
        fetchPolicy: 'network-only',
      });
      if (errors?.length && !data) break;
      result = data?.syncProducts;
    } catch {
      break;
    }
    if (!result) break;
    const items = (result.items ?? []) as any[];
    if (items.length > 0) {
      const snapshots: ProductSnapshot[] = items.map((m) => ({
        variantId: Number(m.variantId),
        sku: m.sku ?? '',
        name: m.name ?? '',
        price: m.price ?? 0,
        priceWithTax: m.priceWithTax ?? 0,
        barcode: m.barcode ?? null,
        categoryId: m.categoryId == null ? null : Number(m.categoryId),
        updatedAt: m.updatedAt ?? new Date().toISOString(),
      }));
      await db.products.bulkPut(snapshots);
    }
    const nextCursor: string = result.cursor ?? cursor;
    await setCursor(SYNC_META_PRODUCTS_KEY, nextCursor);
    if (items.length < PAGE_LIMIT) break;
    if (nextCursor === cursor) break;
    cursor = nextCursor;
  }
}

/** 拉取会员增量。 */
async function syncMembers(): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  let cursor = await getCursor(SYNC_META_MEMBERS_KEY);
  for (let i = 0; i < 50; i++) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    let result: any;
    try {
      const { data, errors } = await apolloClient.query({
        query: SYNC_MEMBERS,
        variables: { since: cursor, limit: PAGE_LIMIT },
        fetchPolicy: 'network-only',
      });
      if (errors?.length && !data) break;
      result = data?.syncMembers;
    } catch {
      break;
    }
    if (!result) break;
    const items = (result.items ?? []) as any[];
    if (items.length > 0) {
      const snapshots: MemberSnapshot[] = items.map((m) => ({
        customerId: Number(m.customerId),
        emailAddress: m.emailAddress ?? '',
        firstName: m.firstName ?? '',
        lastName: m.lastName ?? '',
        memberLevel: m.customFields?.memberLevel ?? 0,
        points: m.customFields?.points ?? 0,
        updatedAt: m.updatedAt ?? new Date().toISOString(),
      }));
      await db.members.bulkPut(snapshots);
    }
    const nextCursor: string = result.cursor ?? cursor;
    await setCursor(SYNC_META_MEMBERS_KEY, nextCursor);
    if (items.length < PAGE_LIMIT) break;
    if (nextCursor === cursor) break;
    cursor = nextCursor;
  }
}

/**
 * 商品/会员增量同步 composable：
 * - onMounted 立即执行一次 + 启动 5 分钟定时器
 * - online 事件触发立即同步
 * - onUnmounted 清理定时器与事件
 */
export function useIncrementalSync() {
  let timer: ReturnType<typeof setInterval> | null = null;

  const run = async () => {
    await Promise.allSettled([syncProducts(), syncMembers()]);
  };

  const handleOnline = () => {
    run();
  };

  onMounted(() => {
    if (typeof window === 'undefined') return;
    run();
    timer = setInterval(run, INTERVAL_MS);
    window.addEventListener('online', handleOnline);
  });

  onUnmounted(() => {
    if (timer) clearInterval(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
    }
  });

  return { syncProducts, syncMembers };
}
