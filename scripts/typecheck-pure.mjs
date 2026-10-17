/**
 * **纯逻辑层类型检查**（`ai` / `domain` / `shared`）。
 *
 * 为什么只查这三层：主机侧 `tsc` 一旦 include 到 import cordis 的代码（`service.ts` /
 * `adapter` / `storage` / `tools`）就 **JS heap OOM** —— 是框架 `Context` 类型增强导致的类型爆炸，
 * 加内存到 8 GB 也没用（机器有 18 GB 空闲）。详见 `docs/开发须知.md` §0.3 ④。
 *
 * 这三层是**判据与解析层**，也是最容易写错的地方，能真类型检查就一定要查。
 * 其余层靠 `scripts/verify-ts-syntax.mjs`（语法级）+ **跑得起来的测试**兜底。
 */
import { writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const config = {
  extends: './tsconfig.base.json',
  compilerOptions: { types: ['node'], skipLibCheck: true },
  include: ['src/ai/**/*.ts', 'src/domain/**/*.ts', 'src/shared/**/*.ts'],
};

const path = '.tmp-pure-tsconfig.json';
writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
try {
  const out = execFileSync(
    process.execPath,
    ['--max-old-space-size=4096', 'node_modules/typescript/bin/tsc', '-p', path, '--noEmit'],
    { encoding: 'utf8' },
  );
  void out;
  console.log('纯逻辑层类型检查通过（ai / domain / shared）：0 错误');
} catch (error) {
  const text = String(error.stdout ?? '') + String(error.stderr ?? '');
  const errors = text.split('\n').filter((line) => line.includes('error TS'));
  console.error(`纯逻辑层类型检查失败：${errors.length} 个错误`);
  for (const line of errors.slice(0, 25)) console.error('  ' + line);
  process.exitCode = 1;
} finally {
  rmSync(path, { force: true });
}