import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 180000,
    hookTimeout: 180000,
    include: ['e2e/**/*.e2e-spec.ts'],
    // Vendure TestServer 占用固定端口（默认 3050），并行运行会端口冲突
    fileParallelism: false,
  },
});
