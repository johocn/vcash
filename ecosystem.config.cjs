// PM2 ecosystem 配置
// 1Panel 部署：在 PM2 管理器中添加项目，指向本文件
// 敏感环境变量（DB_PASSWORD 等）通过 1Panel PM2 管理器的"环境变量"配置注入
// 或在 shell 中 export 后执行 pm2 start
//
// 使用方式：
//   1. 在 1Panel PM2 管理器添加项目，指向 ecosystem.config.cjs
//   2. 在 1Panel PM2 "环境变量"中配置 DB_PASSWORD 等
//   3. 启动后执行 pm2 save（持久化进程列表）
//
// 1Panel 中操作：网站 → 添加反代站点（127.0.0.1:3000）→ 申请 SSL
module.exports = {
  apps: [
    {
      name: 'vcash-server',
      script: 'server/dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        DB_TYPE: 'postgres',
        DB_HOST: process.env.DB_HOST || 'localhost',
        DB_PORT: Number(process.env.DB_PORT || 5432),
        DB_USERNAME: process.env.DB_USERNAME || 'vcash',
        DB_PASSWORD: process.env.DB_PASSWORD || '',
        DB_DATABASE: process.env.DB_DATABASE || 'vcash',
        // 首次部署设为 'true' 自动建表，建表后改 'false' 提升性能与安全
        DB_SYNCHRONIZE: process.env.DB_SYNCHRONIZE || 'false',
        PORT: Number(process.env.PORT || 3000),
        WEB_DIST_DIR: './web/dist',
        ASSET_DIR: './server/assets',
        EMAIL_OUTPUT_DIR: './server/email-output',
      },
      out_file: './logs/vcash-out.log',
      error_file: './logs/vcash-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
