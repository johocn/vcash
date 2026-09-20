import { defineStore } from 'pinia';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';

export interface OrderLineCustomFields {
  originalPrice: number;
  discount: number;
  memberPriceApplied: boolean;
  isGift: boolean;
  note: string | null;
  giftRuleId: number | null;
}

export interface OrderLine {
  id: string;
  productVariant: { id: string; sku: string; name: string };
  unitPrice: number;
  unitPriceWithTax: number;
  quantity: number;
  linePrice: number;
  linePriceWithTax: number;
  customFields: OrderLineCustomFields;
}

export interface Order {
  id: string;
  code: string;
  state: string;
  total: number;
  totalWithTax: number;
  lines: OrderLine[];
  /** 当前应用的促销类型（memberPrice/fullReduction/discount/buyGift），无则为 null */
  promotionType: string | null;
  /** 当前应用的促销规则 ID，无则为 null */
  promotionId: number | null;
  /** 当前应用的促销优惠金额（分），无则为 null */
  promotionDiscount: number | null;
}

/** 会员信息（来自 findMemberByPhone/Code 与 session.customer） */
export interface MemberInfo {
  customerId: string;
  firstName: string | null;
  lastName: string | null;
  emailAddress: string | null;
  phoneNumber: string | null;
  memberLevel: number;
  growthValue: number;
  points: number;
}

const POS_ACTIVE_ORDER = gql`
  query PosActiveOrder {
    posActiveOrder {
      id
      code
      state
      total
      totalWithTax
      promotionType
      promotionId
      promotionDiscount
      lines {
        id
        productVariant {
          id
          sku
          name
        }
        unitPrice
        unitPriceWithTax
        quantity
        linePrice
        linePriceWithTax
        customFields {
          originalPrice
          discount
          memberPriceApplied
          isGift
          note
          giftRuleId
        }
      }
    }
  }
`;

const ADD_POS_ITEM = gql`
  mutation AddPosItem($productVariantId: ID!, $quantity: Int!) {
    addPosItem(input: { productVariantId: $productVariantId, quantity: $quantity }) {
      id
      code
      state
      total
      totalWithTax
      promotionType
      promotionId
      promotionDiscount
      lines {
        id
        productVariant {
          id
          sku
          name
        }
        unitPrice
        unitPriceWithTax
        quantity
        linePrice
        linePriceWithTax
        customFields {
          originalPrice
          discount
          memberPriceApplied
          isGift
          note
          giftRuleId
        }
      }
    }
  }
`;

const UPDATE_POS_ITEM = gql`
  mutation UpdatePosItem($orderLineId: ID!, $quantity: Int!) {
    updatePosItem(input: { orderLineId: $orderLineId, quantity: $quantity }) {
      id
      code
      state
      total
      totalWithTax
      promotionType
      promotionId
      promotionDiscount
      lines {
        id
        productVariant {
          id
          sku
          name
        }
        unitPrice
        unitPriceWithTax
        quantity
        linePrice
        linePriceWithTax
        customFields {
          originalPrice
          discount
          memberPriceApplied
          isGift
          note
          giftRuleId
        }
      }
    }
  }
`;

const BIND_SESSION_MEMBER = gql`
  mutation BindSessionMember($customerId: ID!) {
    bindSessionMember(customerId: $customerId) {
      id
      code
      state
      customerId
      customer {
        id
        firstName
        lastName
      }
    }
  }
`;

const UNBIND_SESSION_MEMBER = gql`
  mutation UnbindSessionMember {
    unbindSessionMember {
      id
      code
      state
      customerId
    }
  }
`;

export const useCartStore = defineStore('cart', {
  state: () => ({
    order: null as Order | null,
    /** 当前班次绑定的会员（未绑定为 null）。后端在 addPosItem 时自动应用会员价。 */
    member: null as MemberInfo | null,
    loading: false,
  }),
  getters: {
    lines: (state) => state.order?.lines ?? [],
    totalWithTax: (state) => state.order?.totalWithTax ?? 0,
    total: (state) => state.order?.total ?? 0,
    itemCount: (state) =>
      (state.order?.lines ?? []).reduce((sum, l) => sum + l.quantity, 0),
    isEmpty: (state) => !state.order || state.order.lines.length === 0,
    hasMember: (state) => state.member !== null,
  },
  actions: {
    async loadActiveOrder() {
      this.loading = true;
      try {
        const { data, errors } = await apolloClient.query({
          query: POS_ACTIVE_ORDER,
          fetchPolicy: 'network-only',
        });
        if (errors?.length && !data) throw new Error(errors[0].message);
        this.order = (data?.posActiveOrder ?? null) as Order | null;
      } finally {
        this.loading = false;
      }
    },
    async addItem(productVariantId: string, quantity: number) {
      this.loading = true;
      try {
        const { data, errors } = await apolloClient.mutate({
          mutation: ADD_POS_ITEM,
          variables: { productVariantId, quantity },
        });
        if (errors?.length) throw new Error(errors[0].message);
        this.order = (data?.addPosItem ?? null) as Order | null;
      } finally {
        this.loading = false;
      }
    },
    async updateItem(orderLineId: string, quantity: number) {
      this.loading = true;
      try {
        const { data, errors } = await apolloClient.mutate({
          mutation: UPDATE_POS_ITEM,
          variables: { orderLineId, quantity },
        });
        if (errors?.length) throw new Error(errors[0].message);
        this.order = (data?.updatePosItem ?? null) as Order | null;
      } finally {
        this.loading = false;
      }
    },
    /**
     * 绑定会员到当前班次：调用后端 bindSessionMember mutation。
     * 成功后写入 this.member；购物车已有的原价行不会自动重算（按 spec：仅新加行应用会员价）。
     */
    async bindMember(member: MemberInfo) {
      const { data, errors } = await apolloClient.mutate({
        mutation: BIND_SESSION_MEMBER,
        variables: { customerId: member.customerId },
      });
      if (errors?.length) throw new Error(errors[0].message);
      this.member = member;
    },
    /** 解绑会员：清空后端 session.customerId 与本地状态。 */
    async unbindMember() {
      const { data, errors } = await apolloClient.mutate({
        mutation: UNBIND_SESSION_MEMBER,
      });
      if (errors?.length) throw new Error(errors[0].message);
      // 后端确认解绑后再清空本地（避免请求失败时本地与后端不一致）
      void data;
      this.member = null;
    },
    clear() {
      this.order = null;
      this.member = null;
    },
  },
});
