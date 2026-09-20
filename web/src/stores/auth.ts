import { defineStore } from 'pinia';
import { gql } from '@apollo/client/core';
import { apolloClient } from '@/api/client';

export interface Channel {
  id: string;
  token: string;
  code: string;
  permissions: string[];
}

const LOGIN_MUTATION = gql`
  mutation Login($username: String!, $password: String!, $rememberMe: Boolean) {
    login(username: $username, password: $password, rememberMe: $rememberMe) {
      ... on CurrentUser {
        id
        identifier
        channels {
          id
          token
          code
          permissions
        }
      }
      ... on InvalidCredentialsError {
        errorCode
        message
      }
      ... on NotVerifiedError {
        errorCode
        message
      }
    }
  }
`;

const ME_QUERY = gql`
  query Me {
    me {
      id
      identifier
      channels {
        id
        token
        code
        permissions
      }
    }
  }
`;

const LOGOUT_MUTATION = gql`
  mutation Logout {
    logout {
      success
    }
  }
`;

function readChannels(): Channel[] {
  try {
    return JSON.parse(localStorage.getItem('vcash_channels') || '[]');
  } catch {
    return [];
  }
}

function readActiveChannel(): Channel | null {
  try {
    return JSON.parse(localStorage.getItem('vcash_active_channel') || 'null');
  } catch {
    return null;
  }
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    sessionToken: localStorage.getItem('vcash_session') as string | null,
    channels: readChannels(),
    activeChannel: readActiveChannel(),
  }),
  getters: {
    isAuthenticated: (state) => !!state.sessionToken,
    hasActiveChannel: (state) => !!state.activeChannel,
  },
  actions: {
    /**
     * 登录：customFetch 已从 response header 提取 session token 存 localStorage。
     * 此处只需处理 body 中的 channels。
     */
    async login(username: string, password: string, rememberMe = true) {
      const { data, errors } = await apolloClient.mutate({
        mutation: LOGIN_MUTATION,
        variables: { username, password, rememberMe },
      });
      if (errors?.length) throw new Error(errors[0].message);
      const result = data?.login;
      if (!result) throw new Error('登录无响应');
      if ('errorCode' in result) {
        throw new Error(result.message || result.errorCode);
      }
      // customFetch 已写入 localStorage.vcash_session
      this.sessionToken = localStorage.getItem('vcash_session');
      this.channels = (result.channels || []) as Channel[];
      localStorage.setItem('vcash_channels', JSON.stringify(this.channels));
      // 自动选第一个 Channel（单租户场景）
      if (this.channels.length > 0 && !this.activeChannel) {
        this.switchChannel(this.channels[0].id);
      }
    },
    switchChannel(channelId: string) {
      const ch = this.channels.find((c) => c.id === channelId);
      if (!ch) return;
      this.activeChannel = ch;
      localStorage.setItem('vcash_active_channel', JSON.stringify(ch));
      // 切换 Channel 必须清空 Apollo 缓存，否则会读到旧 Channel 数据
      apolloClient.clearStore();
    },
    async fetchMe() {
      const { data } = await apolloClient.query({ query: ME_QUERY });
      if (data?.me) {
        this.channels = (data.me.channels || []) as Channel[];
        localStorage.setItem('vcash_channels', JSON.stringify(this.channels));
      }
    },
    async logout() {
      try {
        await apolloClient.mutate({ mutation: LOGOUT_MUTATION });
      } catch {
        // 忽略网络错误，仍清空本地态
      }
      this.sessionToken = null;
      this.channels = [];
      this.activeChannel = null;
      localStorage.removeItem('vcash_session');
      localStorage.removeItem('vcash_channels');
      localStorage.removeItem('vcash_active_channel');
      apolloClient.clearStore();
    },
  },
});
