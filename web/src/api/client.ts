import {
  ApolloClient,
  HttpLink,
  InMemoryCache,
  from,
} from '@apollo/client/core';
import { setContext } from '@apollo/client/link/context';

/**
 * 自定义 fetch：从 response header 提取 session token 存 localStorage。
 * Vendure bearer 模式下 login 成功的 token 在 `vendure-auth-token` header 中，不在 body。
 */
const customFetch = async (uri: string, options: RequestInit): Promise<Response> => {
  const response = await fetch(uri, options);
  const sessionToken = response.headers.get('vendure-auth-token');
  if (sessionToken) {
    localStorage.setItem('vcash_session', sessionToken);
  }
  return response;
};

/** 注入 Authorization: Bearer <session-token> */
const authLink = setContext((_, { headers }) => {
  const sessionToken = localStorage.getItem('vcash_session');
  return {
    headers: {
      ...headers,
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    },
  };
});

/** 注入 vendure-token: <channel-token>（Channel 路由） */
const channelLink = setContext((_, { headers }) => {
  const raw = localStorage.getItem('vcash_active_channel');
  let channelToken: string | null = null;
  if (raw) {
    try {
      channelToken = JSON.parse(raw).token ?? null;
    } catch {
      channelToken = null;
    }
  }
  return {
    headers: {
      ...headers,
      ...(channelToken ? { 'vendure-token': channelToken } : {}),
    },
  };
});

const httpLink = new HttpLink({
  uri: '/admin-api',
  fetch: customFetch as unknown as typeof fetch,
});

export const apolloClient = new ApolloClient({
  link: from([authLink, channelLink, httpLink]),
  cache: new InMemoryCache(),
  defaultOptions: {
    query: { errorPolicy: 'all' },
    mutate: { errorPolicy: 'all' },
  },
});
