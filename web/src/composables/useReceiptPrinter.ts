import { formatMoney } from '@/utils/format';

/** 小票数据结构，与 CheckoutView 的 Receipt 一致 */
export interface ReceiptData {
  orderCode: string;
  orderState: string;
  totalWithTax: number;
  lines: Array<{
    name: string;
    sku: string;
    quantity: number;
    unitPriceWithTax: number;
    linePriceWithTax: number;
  }>;
  payments: Array<{
    method: string;
    amount: number;
    state: string;
  }>;
  offline: boolean;
  /** 促销信息（可选） */
  promotionType?: string | null;
  promotionDiscount?: number | null;
  /** 班次/终端信息（可选） */
  terminalCode?: string;
  sessionCode?: string;
  operatorName?: string;
  createdAt?: string;
}

function methodLabel(method: string): string {
  switch (method) {
    case 'cash': return '现金';
    case 'aggregate': return '聚合码';
    default: return method;
  }
}

function promotionLabel(type: string): string {
  switch (type) {
    case 'memberPrice': return '会员价';
    case 'fullReduction': return '满减';
    case 'discount': return '整单折扣';
    case 'buyGift': return '买赠';
    default: return type;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 生成 80mm 热敏小票 HTML（内联样式，用于新窗口打印）
 */
function buildReceiptHtml(r: ReceiptData): string {
  const time = r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false }) : new Date().toLocaleString('zh-CN', { hour12: false });
  const linesHtml = r.lines.map((l) => `
    <tr>
      <td class="name">${escapeHtml(l.name)}</td>
      <td class="qty">×${l.quantity}</td>
      <td class="price">¥${formatMoney(l.linePriceWithTax)}</td>
    </tr>
    <tr class="sub">
      <td colspan="3">@ ¥${formatMoney(l.unitPriceWithTax)}</td>
    </tr>
  `).join('');

  const paymentsHtml = r.payments.map((p) => `
    <div class="pay-row">
      <span>${methodLabel(p.method)}</span>
      <span>¥${formatMoney(p.amount)}</span>
    </div>
  `).join('');

  const promoHtml = (r.promotionType && r.promotionDiscount && r.promotionDiscount > 0)
    ? `<div class="promo"><span>${promotionLabel(r.promotionType)}优惠</span><span>-¥${formatMoney(r.promotionDiscount)}</span></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>小票 ${escapeHtml(r.orderCode)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 72mm; padding: 2mm; font-family: "Microsoft YaHei", "SimSun", monospace; font-size: 12px; color: #000; }
  .header { text-align: center; border-bottom: 1px dashed #000; padding-bottom: 4px; margin-bottom: 4px; }
  .header .title { font-size: 14px; font-weight: bold; }
  .header .meta { font-size: 11px; margin-top: 2px; color: #333; }
  .meta-row { display: flex; justify-content: space-between; font-size: 11px; margin: 1px 0; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0; }
  tr { border-bottom: 1px dotted #ccc; }
  td { padding: 1px 0; vertical-align: top; }
  td.name { width: 55%; }
  td.qty { width: 15%; text-align: center; }
  td.price { width: 30%; text-align: right; }
  tr.sub td { font-size: 10px; color: #666; border-bottom: none; padding-top: 0; }
  .divider { border-top: 1px dashed #000; margin: 4px 0; }
  .promo { display: flex; justify-content: space-between; padding: 2px 0; font-size: 11px; }
  .total { display: flex; justify-content: space-between; align-items: baseline; padding: 4px 0; font-size: 14px; font-weight: bold; }
  .pay-row { display: flex; justify-content: space-between; padding: 1px 0; font-size: 11px; }
  .footer { text-align: center; font-size: 11px; margin-top: 6px; padding-top: 4px; border-top: 1px dashed #000; }
  .offline-badge { display: inline-block; border: 1px solid #000; padding: 0 4px; font-size: 10px; }
  @media print {
    body { width: auto; padding: 0; }
    @page { margin: 0; size: 80mm auto; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="title">vcash 收银小票</div>
    <div class="meta">
      ${r.terminalCode ? `终端：${escapeHtml(r.terminalCode)}` : ''}
      ${r.operatorName ? ` · 收银员：${escapeHtml(r.operatorName)}` : ''}
    </div>
  </div>
  <div class="meta-row">
    <span>单号：${escapeHtml(r.orderCode) || (r.offline ? '离线订单' : '-')}</span>
    ${r.offline ? '<span class="offline-badge">离线</span>' : ''}
  </div>
  <div class="meta-row"><span>时间：${time}</span></div>
  <table>${linesHtml}</table>
  <div class="divider"></div>
  ${promoHtml}
  <div class="total">
    <span>合计</span>
    <span>¥${formatMoney(r.totalWithTax)}</span>
  </div>
  <div class="divider"></div>
  ${paymentsHtml}
  <div class="footer">
    ${r.offline ? '※ 离线订单，联网后自动同步' : '感谢您的光临，欢迎再次惠顾'}
  </div>
</body>
</html>`;
}

/**
 * 小票打印 composable
 * 使用新窗口写入小票 HTML 并调用浏览器打印（兼容所有打印机，无需 ESC/POS 驱动）
 * 后续真机联调可扩展为 WebSerial + ESC/POS 直连方案
 */
export function useReceiptPrinter() {
  /**
   * 打印小票。打开新窗口 → 写入 HTML → 调用 print → 关闭窗口
   * 注意：部分浏览器会阻止 window.open，需在用户点击交互中调用
   */
  function printReceipt(receipt: ReceiptData): boolean {
    const html = buildReceiptHtml(receipt);
    const printWin = window.open('', '_blank', 'width=400,height=600');
    if (!printWin) {
      return false; // 弹窗被拦截
    }
    printWin.document.open();
    printWin.document.write(html);
    printWin.document.close();
    // 延迟调用 print 确保样式加载完成
    printWin.onload = () => {
      printWin.focus();
      printWin.print();
      // 打印对话框关闭后关闭窗口（部分浏览器需要延迟）
      setTimeout(() => printWin.close(), 300);
    };
    // 兜底：onload 未触发时也能打印
    setTimeout(() => {
      try {
        printWin.focus();
        printWin.print();
        setTimeout(() => printWin.close(), 300);
      } catch {
        // 窗口可能已关闭
      }
    }, 500);
    return true;
  }

  return { printReceipt };
}
