import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useSessionStore } from '@/stores/session';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { public: true },
  },
  {
    path: '/setup',
    name: 'setup',
    component: () => import('@/views/SetupView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/cashier',
    name: 'cashier',
    component: () => import('@/views/CashierView.vue'),
    meta: { requiresAuth: true, requiresSession: true },
  },
  {
    path: '/checkout',
    name: 'checkout',
    component: () => import('@/views/CheckoutView.vue'),
    meta: { requiresAuth: true, requiresSession: true },
  },
  {
    path: '/shift',
    name: 'shift',
    component: () => import('@/views/ShiftView.vue'),
    meta: { requiresAuth: true, requiresSession: true },
  },
  {
    path: '/refund',
    name: 'refund',
    component: () => import('@/views/RefundView.vue'),
    meta: { requiresAuth: true, requiresSession: true },
  },
  {
    path: '/promotions',
    name: 'promotions',
    component: () => import('@/views/PromotionView.vue'),
    meta: { requiresAuth: true, requiresSession: true },
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('@/views/ReportView.vue'),
    meta: { requiresAuth: true, requiresSession: true },
  },
  { path: '/', redirect: '/login' },
  { path: '/:pathMatch(.*)*', redirect: '/login' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  const session = useSessionStore();

  // /login 已登录则跳走
  if (to.meta.public) {
    if (to.path === '/login' && auth.isAuthenticated) {
      return '/setup';
    }
    return true;
  }

  // 未登录 → /login
  if (!auth.isAuthenticated) {
    return '/login';
  }

  // 已登录但未加载过班次状态 → 加载一次（守卫需要据此分流）
  if (!session.loaded) {
    try {
      await session.loadMySession();
    } catch {
      // 网络错误按"未开班"处理
    }
  }

  // 需要已开班但未开班 → /setup
  if (to.meta.requiresSession && !session.isOpen) {
    return '/setup';
  }

  // 已开班访问 /setup → /cashier
  if (to.path === '/setup' && session.isOpen) {
    return '/cashier';
  }

  return true;
});

export default router;
