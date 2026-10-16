/**
 * **排除表本身必须遵守"只用 `**\/<名字>`"这条约定**（0.3.31 的防复发测试）。
 *
 * ## 为什么必须有这条（0.3.31 真机 PEIS 事故的**漏网机制**）
 *
 * `tests/domain/scanner.test.ts` 里早就写着这条约定：
 *
 * > 补排除项**用 `**\/<名字>` 这一种写法就够**，不必（也不该）再写一条裸名。
 *
 * 而且有测试钉住了 `**\/node_modules` 的**语义**（根层+嵌套层都命中）。
 * 但**没有任何测试检查 `DEFAULT_SCAN_EXCLUDE` 自己守不守这条约定** —— 于是那份表里
 * 躺着一排裸名（`node_modules` / `dist` / `build` / `lib` / `out` / `tmp` …），
 * 而裸名**只匹配仓库顶层** ⇒ 嵌套的产物目录全被遍历 ⇒ PEIS 约 8 万产物把骨架预算吃满
 * ⇒ 建出来的树 refs 指向 `Mobile/MPOut/dist/...`、`PEIS.Web/bin/Debug/...`。
 *
 * **教训：约定写进注释和"另一个测试的语义"都不算数 —— 要被约束的那份数据必须自己被测。**
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchesGlob, NON_CODE_ARTIFACT_EXCLUDE } from '../../src/domain/scanner.ts';
import { AI_BUILD_EXCLUDE } from '../../src/ai/scope.ts';
import { DEFAULT_SCAN_EXCLUDE } from '../../src/service.ts';

/** 三张表合起来就是"建树骨架"实际使用的排除集。 */
const ALL_TABLES: Array<{ name: string; list: readonly string[] }> = [
  { name: 'DEFAULT_SCAN_EXCLUDE', list: DEFAULT_SCAN_EXCLUDE },
  { name: 'NON_CODE_ARTIFACT_EXCLUDE', list: NON_CODE_ARTIFACT_EXCLUDE },
  { name: 'AI_BUILD_EXCLUDE', list: AI_BUILD_EXCLUDE },
];

/**
 * 允许出现的"非 `**\/` 形态"。每一条都要说清为什么 —— 不许当垃圾箱。
 *
 * - `**.xxx`：**文件后缀**写法（`**.map`）。它靠 `path.endsWith(suffix)` 判，
 *   本来就跨目录，不存在"只匹配顶层"的问题。
 * - `dir/**`：显式"某目录下全部"，前缀语义明确。
 */
const ALLOWED_NON_STAR_STAR_PREFIX = [/^\*\*\./, /\/\*\*$/];

/**
 * **裸名登记簿：现在是空的，而且必须保持为空**（0.3.32 收尾）。
 *
 * ## 变迁（值得留着，因为它记录了一次"我判断保守过头"的经过）
 *
 * - 0.3.31 修 `DEFAULT_SCAN_EXCLUDE` 时，我**只改了三张表里的一张**；
 *   独立审查指出 `AI_BUILD_EXCLUDE` 还有 **34 条裸名**（同一类 bug）。
 * - 我当时把它们的**现状逐条登记**进这个清单（理由是"改成 `**\/` 会扩大建树范围，
 *   属内容设计判断，不该顺手改"）——**保守，但过头了**。
 * - 后来我在**四个真实仓库**上量了代价：新被排除的全是嵌套 `.gitignore`/`package.json`/
 *   `Dockerfile`/Rust 的 `tests/*.rs` —— **一个作者源码都不冤**，而"排掉测试"本来就是
 *   `AI_BUILD_EXCLUDE` 的设计意图（用户口径"仅主要代码"）。
 * - 于是 0.3.32 把 41 条全部改成 `**\/`，这个登记簿**清空**。
 *
 * 留成空数组而不是删掉它：**它就是那道闸门**。以后任何人要新增一条裸名，
 * 必须来这里写下来 —— 而写下来的那一刻，他就得面对"为什么它可以只匹配顶层"这个问题。
 */
const KNOWN_BARE_IN_AI_BUILD: readonly string[] = [];


describe('排除表：不许出现裸名（裸名只匹配仓库顶层 = 0.3.31 的 bug）', () => {
  for (const table of ALL_TABLES) {
    it(`${table.name} 的每一条都跨目录生效`, () => {
      const bare = table.list.filter((glob) => {
        if (glob.startsWith('**/')) return false; // 正确形态
        if (glob === '**') return false; // 明确的"全匹配"
        return !ALLOWED_NON_STAR_STAR_PREFIX.some((re) => re.test(glob));
      });
      const allowed =
        table.name === 'AI_BUILD_EXCLUDE'
          ? bare.filter((g) => KNOWN_BARE_IN_AI_BUILD.includes(g))
          : [];
      const unexpected = bare.filter((g) => !allowed.includes(g));
      assert.deepEqual(
        unexpected,
        [],
        `**${table.name} 里出现了未经登记的裸名**：` +
          JSON.stringify(unexpected) +
          ' —— 裸名只匹配仓库顶层。改成 `**/<名字>`，或（若是内容设计判断）' +
          '把它加进本测试的 KNOWN_BARE_IN_AI_BUILD 清单显式表态。',
      );
    });
    it(`${table.name} 的每一条都真的能命中嵌套路径（根层也要命中）`, () => {
      const broken: string[] = [];
      for (const glob of table.list) {
        // 取一个"名字"来构造嵌套路径：`**/x` → x；`**.map` → 后缀形态另测
        if (glob.startsWith('**.')) {
          const suffix = glob.slice(2);
          if (matchesGlob(`a/b/c/file${suffix}`, glob) !== true) broken.push(glob);
          continue;
        }
        if (glob.endsWith('/**')) continue; // 前缀语义，另有测试
        if (glob === '**') continue;
        if (table.name === 'AI_BUILD_EXCLUDE' && KNOWN_BARE_IN_AI_BUILD.includes(glob)) {
          /**
           * 已登记的裸名：它**故意**只匹配顶层（见上面那份清单的说明 —— 把它改成 `**\/`
           * 会扩大建树范围，属内容设计判断）。这里**显式跳过并留下记录**，
           * 而不是让它混在"跨目录"的断言里假装通过。
           */
          continue;
        }
        const name = glob.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
        if (matchesGlob(`a/b/${name}/x`, glob) !== true) broken.push(glob);
      }
      assert.deepEqual(
        broken,
        [],
        `**这些 glob 命中不了嵌套路径**（裸名只匹配顶层，正是 0.3.31 修的）：` + JSON.stringify(broken),
      );
    });
  }

  it('回归：真机上那些产物路径必须全部被排除（PEIS 现场样本）', () => {
    const artifacts = [
      'Mobile/MPOut/dist/build/h5/assets/pages-Login-Login.24746e3d.js',
      'Mobile/MPOut/node_modules/vue/index.js',
      'PEIS.Web/bin/Debug/net8.0/PEIS.Web.dll',
      'PEIS.Test/obj/project.assets.json',
      'out/publish/PEIS.Web.dll',
      'tmp/aes-probe/x.js',
    ];
    const all = ALL_TABLES.flatMap((t) => t.list);
    const leaked = artifacts.filter((p) => !all.some((g) => matchesGlob(p, g) === true));
    assert.deepEqual(leaked, [], '这些真机产物路径必须被排除：' + JSON.stringify(leaked));
  });
});
