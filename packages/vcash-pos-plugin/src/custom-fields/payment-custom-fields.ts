import { CustomFieldConfig, LanguageCode } from '@vendure/core';

/**
 * Payment custom fields：聚合码支付相关
 * - aggregatePayCode: 聚合码贴纸支付时返回的唯一码（用于关班时核对）
 * - aggregatePayStatus: pending/confirmed/settled/failed/refunded
 * - needsManualRefund: 退货时是否需要人工退款（聚合码已结算的需人工）
 * - posSessionId: 关联班次，便于按班次聚合支付明细
 */
const AGGREGATE_PAY_STATUS_VALUES = [
  'pending',
  'confirmed',
  'settled',
  'failed',
  'refunded',
] as const;

export const paymentCustomFields: CustomFieldConfig[] = [
  {
    name: 'aggregatePayCode',
    type: 'string',
    nullable: true,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '聚合码支付唯一码' }],
  },
  {
    name: 'aggregatePayStatus',
    type: 'string',
    nullable: true,
    public: false,
    validate: (value: string) => {
      if (
        value != null &&
        !AGGREGATE_PAY_STATUS_VALUES.includes(value as any)
      ) {
        return `aggregatePayStatus 仅支持取值 ${AGGREGATE_PAY_STATUS_VALUES.join(' | ')}，实际收到 ${value}`;
      }
    },
    label: [{ languageCode: LanguageCode.zh_Hans, value: '聚合码支付状态' }],
  },
  {
    name: 'needsManualRefund',
    type: 'boolean',
    nullable: false,
    defaultValue: false,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '是否需人工退款' }],
  },
  {
    name: 'posSessionId',
    type: 'int',
    nullable: true,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '关联班次 ID' }],
  },
];
