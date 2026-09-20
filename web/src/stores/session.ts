import { defineStore } from 'pinia';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';

export interface PosSession {
  id: string;
  code: string;
  state: string;
  openedAt: string;
  openingFloat: number | null;
  terminal: { id: string; code: string; name: string };
  operator: { id: string; identifier: string; firstName?: string; lastName?: string };
}

export interface CloseSessionResult {
  session: PosSession;
  summary: unknown;
}

const MY_POS_SESSION = gql`
  query MyPosSession {
    myPosSession {
      id
      code
      state
      openedAt
      openingFloat
      terminal {
        id
        code
        name
      }
      operator {
        id
        identifier
        firstName
        lastName
      }
    }
  }
`;

const OPEN_SESSION = gql`
  mutation OpenSession($terminalCode: String!, $openingFloat: Int) {
    openSession(input: { terminalCode: $terminalCode, openingFloat: $openingFloat }) {
      id
      code
      state
      openedAt
      openingFloat
      terminal {
        id
        code
        name
      }
      operator {
        id
        identifier
        firstName
        lastName
      }
    }
  }
`;

const CLOSE_SESSION = gql`
  mutation CloseSession($sessionId: ID!, $closingCash: Int, $approverId: ID) {
    closeSession(
      input: { sessionId: $sessionId, closingCash: $closingCash, approverId: $approverId }
    ) {
      session {
        id
        code
        state
        openedAt
        closedAt
        openingFloat
        closingCash
      }
      summary
    }
  }
`;

export const useSessionStore = defineStore('session', {
  state: () => ({
    currentSession: null as PosSession | null,
    loaded: false,
    loading: false,
  }),
  getters: {
    isOpen: (state) => state.currentSession?.state === 'open',
  },
  actions: {
    async loadMySession() {
      this.loading = true;
      try {
        const { data, errors } = await apolloClient.query({
          query: MY_POS_SESSION,
          fetchPolicy: 'network-only',
        });
        if (errors?.length && !data) throw new Error(errors[0].message);
        this.currentSession = (data?.myPosSession ?? null) as PosSession | null;
      } finally {
        this.loaded = true;
        this.loading = false;
      }
    },
    async openSession(terminalCode: string, openingFloat?: number): Promise<PosSession> {
      const { data, errors } = await apolloClient.mutate({
        mutation: OPEN_SESSION,
        variables: {
          terminalCode,
          openingFloat: openingFloat ?? null,
        },
      });
      if (errors?.length) throw new Error(errors[0].message);
      const session = data?.openSession as PosSession | undefined;
      if (!session) throw new Error('开班失败：无响应');
      this.currentSession = session;
      return session;
    },
    async closeSession(
      sessionId: string,
      closingCash?: number,
      approverId?: string,
    ): Promise<CloseSessionResult> {
      const { data, errors } = await apolloClient.mutate({
        mutation: CLOSE_SESSION,
        variables: {
          sessionId,
          closingCash: closingCash ?? null,
          approverId: approverId ?? null,
        },
      });
      if (errors?.length) throw new Error(errors[0].message);
      const result = data?.closeSession as CloseSessionResult | undefined;
      if (!result) throw new Error('关班失败：无响应');
      this.currentSession = null;
      this.loaded = false;
      return result;
    },
    reset() {
      this.currentSession = null;
      this.loaded = false;
    },
  },
});
