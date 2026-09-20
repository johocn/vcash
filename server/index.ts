import { bootstrap } from '@vendure/core';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './vendure-config';

/**
 * 生产模式（NODE_ENV=production）下托管 web 构建产物：
 * - 前端构建到 web/dist，由 Vendure 静态托管于 / 路径
 * - /admin-api、/shop-api、/assets 由 Vendure 处理
 * - 其余路径回退到 index.html（SPA history 路由）
 *
 * 实现说明：不依赖 express 包，直接用 Node.js 原生 fs 实现
 * 兼容 Express middleware 签名 (req, res, next) => void
 */
const isProd = process.env.NODE_ENV === 'production';
const webDist = process.env.WEB_DIST_DIR ?? path.join(__dirname, '..', 'web', 'dist');

// 常见静态资源 MIME 类型映射
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

if (isProd) {
  if (!fs.existsSync(webDist)) {
    console.warn(`[vcash] 前端构建产物不存在: ${webDist}，请先执行 pnpm --filter @vcash/web build`);
  }
  // 通过 apiOptions.middleware 注入 SPA 静态托管
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const staticHandler = (req: any, res: any, next: any) => {
    // 仅处理 GET/HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // 解析请求路径，防止路径遍历
    const urlPath = decodeURIComponent((req.path || '/').split('?')[0]);
    const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(webDist, safePath);
    // 确保文件在 webDist 目录内
    if (!filePath.startsWith(path.resolve(webDist))) return next();
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        // 不是文件 → 交给 SPA fallback
        return next();
      }
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      // 使用 stream 传输文件
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => next());
      stream.pipe(res);
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spaFallbackHandler = (req: any, res: any, next: any) => {
    if (
      req.path.startsWith('/admin-api') ||
      req.path.startsWith('/shop-api') ||
      req.path.startsWith('/assets') ||
      req.path.startsWith('/health')
    ) {
      return next();
    }
    const indexPath = path.join(webDist, 'index.html');
    fs.readFile(indexPath, (err, data) => {
      if (err) return next();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(data);
    });
  };

  config.apiOptions.middleware = [
    ...(config.apiOptions.middleware ?? []),
    { handler: staticHandler, route: '/' },
    { handler: spaFallbackHandler, route: '/*' },
  ];
}

bootstrap(config).catch((err) => {
  console.error('Vendure 启动失败:', err);
  process.exit(1);
});
