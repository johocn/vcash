const esbuild = require('esbuild');
const fs = require('fs');
const code = fs.readFileSync('e2e/report.e2e-spec.ts', 'utf8');

(async () => {
  // 把所有 const XXX = gql`...`; 替换为 const XXX = '';
  const noGql = code.replace(/const (\w+) = gql`[\s\S]*?`;/g, "const $1 = '';");
  try {
    await esbuild.transform(noGql, { loader: 'ts' });
    console.log('no gql: OK');
  } catch (e) {
    console.log('no gql ERR:', e.errors?.[0]?.location?.line, e.errors?.[0]?.text);
  }

  // 把所有 gql`...` 替换为 ''
  const noGql2 = code.replace(/gql`[\s\S]*?`/g, "''");
  try {
    await esbuild.transform(noGql2, { loader: 'ts' });
    console.log('no gql2: OK');
  } catch (e) {
    console.log('no gql2 ERR:', e.errors?.[0]?.location?.line, e.errors?.[0]?.text);
  }
})();
