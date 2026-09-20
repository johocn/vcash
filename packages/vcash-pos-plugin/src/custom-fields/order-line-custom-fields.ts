import { CustomFieldConfig, LanguageCode } from '@vendure/core';

/**
 * OrderLine custom fields：
 * - originalPrice: 原价（分），用于折扣展示与对账
 * - discount: 折扣百分比 100=原价 80=8 折，便于收银员改价
 * - memberPriceApplied: 是否已应用会员价
 * - isGift: 是否赠品（不参与金额计算）
 * - note: 行备注（如称重商品净重）
 * - originalOrderLineId: 退货行关联的原单行 ID
 * - giftRuleId: 买赠规则 ID（reapply 时按此清理旧 gift line，避免重复加）
 */
export const orderLineCustomFields: CustomFieldConfig[] = [
  {
    name: 'originalPrice',
    type: 'int',
    nullable: false,
    defaultValue: 0,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '原价(分)' }],
  },
  {
    name: 'discount',
    type: 'int',
    nullable: false,
    defaultValue: 100,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '折扣百分比(100=原价)' }],
  },
  {
    name: 'memberPriceApplied',
    type: 'boolean',
    nullable: false,
    defaultValue: false,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '是否已应用会员价' }],
  },
  {
    name: 'isGift',
    type: 'boolean',
    nullable: false,
    defaultValue: false,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '是否赠品' }],
  },
  {
    name: 'note',
    type: 'string',
    nullable: true,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '行备注' }],
  },
  {
    name: 'originalOrderLineId',
    type: 'int',
    nullable: true,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '退货行关联的原单行 ID' }],
  },
  {
    name: 'giftRuleId',
    type: 'int',
    nullable: true,
    public: false,
    label: [{ languageCode: LanguageCode.zh_Hans, value: '买赠规则 ID（reapply 时按此清理）' }],
  },
];
