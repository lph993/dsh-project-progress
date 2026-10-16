/**
 * **排除表必须在任意深度生效**（0.3.31，真机 PEIS 现场取证）。
 *
 * ## 缺陷
 *
 * `matchesGlob(path, glob)` 对**裸名**的判据是 `path === glob || path.startsWith(glob + '/')`
 * —— 裸名**只匹配仓库顶层**。而扫描器剪枝时传的是**工作区相对路径**，于是：
 *
 * ```
 * matchesGlob('node_modules',              'node_modules') = true
 * matchesGlob('Mobile/MPOut/node_modules', 'node_modules') = false   ← 嵌套的漏了
 * matchesGlob('PEIS.Web/bin/Debug/net8.0', 'bin')          = false   ← 嵌套的漏了
 * ```
 *
 * ## 真机后果（PEIS，约 9 万文件）
 *
 * 每一个嵌套的 `node_modules` / `dist` / `bin` 都被**完整遍历**，骨架预算（400 条）被构建产物吃满
 * ⇒ 建出来的树 refs 指向 `Mobile/MPOut/dist/build/h5/assets/pages-*.js`、
 * `PEIS.Web/bin/Debug/net8.0` 这类**产物**而非源码。
 *
 * 本测试用**真实的临时目录树**跑一遍扫描，钉住"嵌套的也排除"这个行为。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { scanWorkspaceEntries } from '../../src/adapter/workspace.ts';
import { NON_CODE_ARTIFACT_EXCLUDE } from '../../src/domain/scanner.ts';

/** 与 `src/service.ts` 的 `DEFAULT_SCAN_EXCLUDE` 同源（这里只取被测的那几条，避免复制整表）。 */
const EXCLUDE = [...NON_CODE_ARTIFACT_EXCLUDE, '**/node_modules', '**/dist', '**/bin', '**/obj'];

describe('排除表：嵌套的构建产物也必须被剪掉', () => {
  it('顶层与嵌套的 node_modules / dist / bin / obj 都不进扫描结果', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-exclude-'));
    const write = (rel: string): void => {
      const abs = join(root, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, 'x');
    };
    // 真正该被看见的源码
    write('PEIS.Web/Views/Home/Index.cshtml');
    write('Modules/PEIS.Card/CardController.cs');
    // 顶层产物
    write('node_modules/pkg/index.js');
    write('dist/bundle.js');
    // **嵌套**产物 —— 缺陷就在这里（裸名 glob 只匹配顶层）
    write('Mobile/MPOut/node_modules/vue/index.js');
    write('Mobile/MPOut/dist/build/h5/app.js');
    write('PEIS.Web/bin/Debug/net8.0/PEIS.Web.dll');
    write('PEIS.Web/obj/project.assets.json');
    write('PEIS.Test/bin/Debug/net8.0/PEIS.Test.dll');

    const walked = await scanWorkspaceEntries({ root, maxDepth: 8, exclude: EXCLUDE, countLines: false });
    const paths = walked.entries.map((e) => e.path.replace(/\\/g, '/'));

    assert.ok(
      paths.includes('PEIS.Web/Views/Home/Index.cshtml'),
      '真实源码必须被扫到：' + JSON.stringify(paths),
    );
    assert.ok(
      paths.includes('Modules/PEIS.Card/CardController.cs'),
      '真实源码必须被扫到：' + JSON.stringify(paths),
    );
    const leaked = paths.filter((p) =>
      /(^|\/)(node_modules|dist|bin|obj)(\/|$)/.test(p),
    );
    assert.deepEqual(
      leaked,
      [],
      '**任意深度的 node_modules/dist/bin/obj 都不许进结果**（裸名 glob 只匹配顶层，是 0.3.31 修掉的缺陷）：' +
        JSON.stringify(leaked),
    );

    rmSync(root, { recursive: true, force: true });
  });
});
