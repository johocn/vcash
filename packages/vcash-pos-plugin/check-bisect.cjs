const esbuild = require('esbuild');
const fs = require('fs');
const code = fs.readFileSync('e2e/report.e2e-spec.ts', 'utf8');

const describeStart = code.indexOf("describe('ReportService");
const beforeDescribe = code.slice(0, describeStart);
const describeContent = code.slice(describeStart);

const lines = describeContent.split('\n');

(async () => {
  // 二分法：保留前 N 行，后面用 }); 结束
  for (const n of [20, 40, 60, 80, 100, 120, 140, 160, 180, 200]) {
    const slice = lines.slice(0, n).join('\n');
    // 确保 }; 闭合
    const testCode = beforeDescribe + slice + '\n});\n';
    try {
      await esbuild.transform(testCode, { loader: 'ts' });
      console.log('first', n, 'lines of describe: OK');
    } catch (e) {
      console.log('first', n, 'lines of describe: ERR', e.errors?.[0]?.location?.line);
    }
  }
})();
