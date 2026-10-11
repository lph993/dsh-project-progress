/**
 * 建树范围（FR-170）纯函数契约。
 *
 * 用户口径两轮，第二轮是关键澄清：
 * ① "仅主要代码就行，示例，测试，生成物，配置等都可以排除"；
 * ② **"生成物的生成代码和生成配置和读取代码不能排除，只针对生成物本身和配置文件本身"**。
 *
 * 所以这个文件里**一半断言在测"该排的排掉了"，另一半在测"不该排的没被排掉"** ——
 * 后者才是容易一刀切错的地方（第一版就把 `scripts` 与 `**.config.*` 一起排了，
 * 等于把构建管线从树上抹掉）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AI_BUILD_EXCLUDE, isNonCodeArtifact, isOutsideMainCode } from '../../src/ai/scope.ts';
import { NON_CODE_ARTIFACT_EXCLUDE } from '../../src/domain/scanner.ts';

/**
 * 各生态的**非代码产物**（2026-10-11 补上；批次 70 只钉了 glob 语义、排除项本身没补）。
 *
 * 真机后果（AIG 工作区，2026-10-11）：`.venv` 有 **67233** 个文件、`aitest` 23313、
 * `server` 17151 —— 建树骨架被非代码文件整片淹掉，模型只能抓住几个"文本丰富"的目录
 * 编树，结果 5 个分支全在描述编辑器脚手架，真代码（`server/` `client/` `nrfunc-rs/`）
 * 一个节点都没有；而且 `.venv` / `.mypy_cache` 还成了节点的 refs。
 */
test('排除：各生态的非代码产物（虚拟环境 / 缓存 / 构建输出 / 日志）', () => {
  for (const path of [
    '.venv/Lib/site-packages/aiohttp/client.py',
    'server/.venv/lib/x.py',
    'aitest/venv/lib/x.py',
    'nrfunc/__pycache__/mod.cpython-311.pyc',
    '.mypy_cache/3.11/os.json',
    'nrfunc/.pytest_cache/v/cache/lastfailed',
    '.ruff_cache/x',
    'nrfunc-rs/target/debug/build/x',
    'server/logs/app.log',
  ]) {
    assert.equal(isOutsideMainCode(path), true, `${path} 应被排除`);
  }
});

test('保留：真代码与文档（排的是"东西"，不是某个名字恰好叫 target/logs）', () => {
  for (const path of [
    'server/crates/entity/src/genetics.rs',
    'client/scenes/main.tscn',
    'nrfunc-rs/src/lib.rs',
    'docs/开发立项-六章技术方案.md',
  ]) {
    assert.equal(isOutsideMainCode(path), false, `${path} **不该**被排除`);
  }
});

test('refs 校验（isNonCodeArtifact）只排非代码产物，不排测试/示例', () => {
  assert.equal(isNonCodeArtifact('.venv/x.py'), true);
  assert.equal(isNonCodeArtifact('server/logs/a.log'), true);
  assert.equal(isNonCodeArtifact('nrfunc-rs/target/debug/x'), true);
  assert.equal(
    isNonCodeArtifact('tests/domain/state.test.ts'),
    false,
    '「补单元测试」的节点本来就该能 refs 到 tests/ —— 不能拿骨架那整张表来卡',
  );
  assert.equal(isNonCodeArtifact('examples/demo.ts'), false, '示例是真实文件，refs 允许指向');
  assert.equal(isNonCodeArtifact('server/crates/x.rs'), false);
});

/**
 * **不许写"永不命中"的模式**。本仓库 glob 只认双星号：单星号通配实测不生效
 * （`**.egg-info` 与"双星号+斜杠+单星号"的写法对 `a/b.egg-info/PKG-INFO` 都不匹配；
 * "双星号+斜杠+.venv+单星号"对 `server/.venv/lib/x.py` 也不匹配）。
 * 写一条不命中的排除项比缺一条更坏 —— 后人会以为已经排掉了（批次 70 的教训）。
 */
test('排除表里不允许出现"单星号"模式（实测不生效）', () => {
  for (const [label, list] of [
    ['AI_BUILD_EXCLUDE', AI_BUILD_EXCLUDE],
    ['NON_CODE_ARTIFACT_EXCLUDE', NON_CODE_ARTIFACT_EXCLUDE],
  ] as const) {
    for (const glob of list) {
      const singleStar = glob.replace(/\*\*/g, '').includes('*');
      assert.equal(singleStar, false, `${label} 里的 ${glob} 含单星号通配 —— 实测不生效，别写`);
    }
  }
});

test('排除：测试 / 示例 / 端到端脚本', () => {
  for (const path of [
    'tests/client/labels.test.ts',
    'src/domain/state.test.tsx',
    'test/helper.ts',
    '__tests__/a.ts',
    '__mocks__/fs.ts',
    'fixtures/sample.json',
    'examples/demo.ts',
    'demo/play.ts',
    'playground/index.tsx',
    'e2e/smoke.spec.ts',
  ]) {
    assert.equal(isOutsideMainCode(path), true, `${path} 应被排除`);
  }
});

test('排除：**产物本身**（目录/缓存），而不是生成它的代码', () => {
  for (const path of [
    '.render-check/render-check.mjs',
    '.render-check/render-check.d.ts',
    '.turbo/cache.json',
    '.next/server/page.js',
    'vendor/lib.js',
  ]) {
    assert.equal(isOutsideMainCode(path), true, `${path} 应被排除`);
  }
});

test('排除：**配置文件本身**', () => {
  for (const path of [
    'tsconfig.json',
    'tsconfig.host.json',
    'package.json',
    'pnpm-lock.yaml',
    'cordis.patch.yml',
    'Dockerfile',
    'Makefile',
    '.eslintrc.json',
    '.prettierrc',
    '.editorconfig',
    '.github/workflows/ci.yml',
    '.vscode/settings.json',
  ]) {
    assert.equal(isOutsideMainCode(path), true, `${path} 应被排除`);
  }
});

/**
 * **这一组是本次澄清的核心**：代码与"关于产物的代码"一律保留 ——
 * 包括生成产物的脚本、生成用的配置、以及读取/加载产物的代码。
 */
test('保留：生成产物的代码、生成配置、读取代码（用户澄清的界线）', () => {
  for (const path of [
    'scripts/wrap-client-bundle.mjs',
    'scripts/render-check.tsx',
    'scripts/verify-artifacts.mjs',
    'tsdown.config.ts',
    'scripts/render-check.tsdown.config.ts',
    'vite.config.ts',
    'src/adapter/ai-cache-store.ts', // 读取缓存产物（生成物）的代码
    'src/storage/file-port.ts', // 读回落到磁盘产物的代码
    'src/domain/scanner.ts',
    'README.md',
    'docs/立项审查-痛点与宗旨.md', // 文档既不是示例也不是产物/配置，未列入排除（需要时可自行加）
    'src/data/user.schema.json', // 一刀切 `**.json` 会把真实数据也挡掉 —— 所以只点名具体配置文件
    'tools/build.ts',
  ]) {
    assert.equal(isOutsideMainCode(path), false, `${path} **不该**被排除`);
  }
});

test('排除表里不允许出现"代码类"模式（防止下次又顺手加回 scripts / **.config.*）', () => {
  assert.ok(!AI_BUILD_EXCLUDE.includes('scripts'), 'scripts 是构建代码，不能整目录排除');
  assert.ok(
    !AI_BUILD_EXCLUDE.some((glob) => glob.includes('.config.')),
    '`**.config.*` 属于"生成配置"，里面有逻辑，不能排除',
  );
  assert.ok(!AI_BUILD_EXCLUDE.includes('docs'), '文档未被列为排除项（它既非示例也非产物/配置）');
});
