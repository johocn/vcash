import { onMounted, onUnmounted } from 'vue';

export interface UseScannerOptions {
  onScan: (barcode: string) => void;
  /** 条码最小长度，默认 4 */
  minLength?: number;
  /** 连续两次按键最大间隔（ms），超过则视为人工输入，默认 50 */
  maxInterval?: number;
}

/**
 * HID 扫码枪 composable：
 * 监听 window keydown，间隔 < maxInterval 的连续字符输入 + Enter 视为扫码。
 * 人工输入（间隔 > maxInterval）或非字符键（除 Enter）会重置缓冲区。
 */
export function useScanner(options: UseScannerOptions) {
  const minLength = options.minLength ?? 4;
  const maxInterval = options.maxInterval ?? 50;

  let buffer = '';
  let lastTime = 0;

  function handleKeydown(e: KeyboardEvent) {
    const now = Date.now();
    const interval = now - lastTime;

    // 间隔过长（人工输入）或非字符非 Enter 键 → 重置缓冲区
    if (interval > maxInterval || (e.key.length > 1 && e.key !== 'Enter')) {
      buffer = '';
    }

    if (e.key === 'Enter') {
      if (buffer.length >= minLength) {
        options.onScan(buffer);
        e.preventDefault();
      }
      buffer = '';
      return;
    }

    if (e.key.length === 1) {
      buffer += e.key;
      lastTime = now;
    }
  }

  onMounted(() => window.addEventListener('keydown', handleKeydown));
  onUnmounted(() => window.removeEventListener('keydown', handleKeydown));
}
