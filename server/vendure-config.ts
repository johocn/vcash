import { configureDefaultOrderProcess, DefaultLogger, LogLevel, VendureConfig } from '@vendure/core';
import { CjkPlugin } from '@vendure/cjk-plugin';
import { MemberLevelPlugin } from '@vendure/member-level-plugin';
import { VcashPosPlugin } from '@vcash/pos-plugin';
import { VcashOfflinePlugin } from '@vcash/offline-plugin';
import { AssetServerPlugin } from '@vendure/asset-server-plugin';
import { defaultEmailHandlers, EmailPlugin, FileBasedTemplateLoader } from '@vendure/email-plugin';
import path from 'node:path';

/**
 * 生产/开发环境通过环境变量切换：
 * - DB_TYPE: better-sqlite3（默认，开发）| postgres（生产）
 * - DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE: postgres 连接参数
 * - PORT: 监听端口，默认 3000
 * - LOG_LEVEL: 日志级别，默认 Info
 * - ASSET_DIR/EMAIL_OUTPUT_DIR: 资源/邮件输出目录，默认同目录下
 */
const isProd = process.env.NODE_ENV === 'production';
const dbType = (process.env.DB_TYPE ?? 'better-sqlite3') as 'better-sqlite3' | 'postgres';

const dbConnectionOptions: VendureConfig['dbConnectionOptions'] =
  dbType === 'postgres'
    ? {
        type: 'postgres',
        host: process.env.DB_HOST ?? 'localhost',
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_USERNAME ?? 'vcash',
        password: process.env.DB_PASSWORD ?? 'vcash',
        database: process.env.DB_DATABASE ?? 'vcash',
        // 首次部署设 DB_SYNCHRONIZE=true 自动建表；建表后改 false 提升性能与安全
        synchronize: process.env.DB_SYNCHRONIZE === 'true',
        logging: false,
      }
    : {
        type: 'better-sqlite3',
        database: path.join(__dirname, 'sqlite.db'),
        synchronize: true,
        logging: false,
      };

export const config: VendureConfig = {
  apiOptions: {
    adminApiPath: 'admin-api',
    shopApiPath: 'shop-api',
    port: Number(process.env.PORT ?? 3000),
    hostname: '0.0.0.0',
    cors: {
      origin: true,
      credentials: true,
    },
  },
  authOptions: {
    tokenMethod: 'bearer',
    requireVerification: false,
    cookieOptions: {
      sameSite: 'lax',
      // 仅 tokenMethod='cookie' 时生效；bearer 模式 token 存于 DB，重启不失效
      secret: process.env.VENDURE_COOKIE_SECRET,
    },
  },
  dbConnectionOptions,
  paymentOptions: {
    paymentMethodHandlers: [],
  },
  orderOptions: {
    process: [
      configureDefaultOrderProcess({
        arrangingPaymentRequiresCustomer: false,
        arrangingPaymentRequiresShipping: false,
      }),
    ],
  },
  logger: new DefaultLogger({ level: isProd ? LogLevel.Warn : LogLevel.Info }),
  plugins: [
    CjkPlugin.init({}),
    MemberLevelPlugin.init({
      defaultPointsEarnRatio: 1,
      defaultPointsEarnOnShipping: false,
    }),
    VcashPosPlugin,
    VcashOfflinePlugin,
    AssetServerPlugin.init({
      assetUploadDir: process.env.ASSET_DIR ?? path.join(__dirname, 'assets'),
      route: 'assets',
    }),
    EmailPlugin.init({
      handlers: defaultEmailHandlers,
      templateLoader: new FileBasedTemplateLoader(path.join(__dirname, 'email-templates')),
      transport: {
        type: 'file',
        outputPath: process.env.EMAIL_OUTPUT_DIR ?? path.join(__dirname, 'email-output'),
      },
    }),
  ],
};
