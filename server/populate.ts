import { bootstrap, LanguageCode } from '@vendure/core';
import { populate } from '@vendure/core/cli';
import path from 'node:path';

import { config } from './vendure-config';

const initialData = {
    defaultLanguage: LanguageCode.zh,
    defaultZone: '中国',
    countries: [{ code: 'CN', name: '中国', zone: '中国' }],
    taxRates: [{ name: 'standard', percentage: 0 }],
    shippingMethods: [],
    paymentMethods: [],
    collections: [],
    roles: [
        { code: 'cashier', description: '收银员', permissions: ['Authenticated'] as any },
        { code: 'shift-manager', description: '班次经理', permissions: ['Authenticated'] as any },
    ],
};

async function run() {
    const app = await populate(
        () => bootstrap(config),
        initialData,
        path.join(__dirname, '__tests__/fixtures/products.csv'),
        '__default_channel__',
    );
    try {
        console.log('populate 完成');
    } finally {
        await app.close();
    }
    process.exit(0);
}

run().catch((err) => {
    console.error('populate 失败:', err);
    process.exit(1);
});
