/**
 * **AI 建树的范围**：默认只给"主要代码"，把示例 / 测试 / 生成物 / 配置挡在外面。
 *
 * 用户口径（原话两轮，第二轮是关键澄清）：
 * ① "仅主要代码就行，示例，测试，生成物，配置等都可以排除"；
 * ② **"生成物的生成代码和生成配置和读取代码不能排除，只针对生成物本身和配置文件本身"**。
 *
 * ## 那条澄清划出的界线（本文件的核心）
 *
 * | 类别 | 例子 | 排除？ | 为什么 |
 * |---|---|---|---|
 * | **产物本身** | `lib/`、`dist/`、`.render-check/`（目录）、`**.map` | ✅ 排除 | 它们是**结果**，不是功能；建出来的都是重复节点（历史上真发生过） |
 * | **配置文件本身** | `tsconfig.json`、`package.json`、`cordis.patch.yml`、`.eslintrc*` | ✅ 排除 | 声明式数据，不是功能点 |
 * | **生成产物的代码** | `scripts/wrap-client-bundle.mjs`、`scripts/render-check.tsx` | ❌ **保留** | 它们**是项目代码**（构建管线也是功能） |
 * | **生成用的配置** | `tsdown.config.ts`、`*.config.ts` | ❌ **保留** | 里面有逻辑，是"怎么产出"的一部分 |
 * | **读取/加载产物的代码** | 运行期加载 `lib/` 的入口、解析配置的代码 | ❌ **保留** | 同属主要代码 |
 *
 * 换句话说：**排的是"东西"，不是"关于东西的代码"**。
 * 这条界线很容易一刀切错（我第一版就把 `scripts` 和 `**.config.*` 一起排了 ——
 * 那等于把"构建管线"从树上抹掉）。
 *
 * ## 为什么不做成 `DEFAULT_SCAN_EXCLUDE` 的一部分
 *
 * "只看主要代码"是**建树这一个场景**的口径，所以做成叠加层：
 * `DEFAULT_SCAN_EXCLUDE + AI_BUILD_EXCLUDE + 用户自己的 scanExclude`。
 *
 * ⚠️ **注释更正**（0.3.32，独立审查核实）：这里原先写"`DEFAULT_SCAN_EXCLUDE` 服务**扫描 / 建树 /
 * 行数统计多条路径**，改它会波及所有路径" —— **不成立（过时）**。全仓 grep `DEFAULT_SCAN_EXCLUDE`
 * 共 7 处，**生产代码只有 1 个使用点**（`service.ts` 的 `collectAiSkeleton`）；
 * `scanWorkspace` 没有生产调用者，`DEFAULT_SCAN_OPTIONS.exclude` 是 `[]`。
 * 所以改那张表**只影响 AI 建树** —— 这条更正**缩小**了改动面，留着旧说法会让人误判波及范围。
 */

import { matchesGlob, NON_CODE_ARTIFACT_EXCLUDE } from '../domain/scanner.ts';

/**
 * 建树时额外排除的 glob（在 `DEFAULT_SCAN_EXCLUDE` 之上叠加）。
 *
 * **注意**：这里只放"产物本身"与"配置文件本身"。
 * 像 `scripts`、`**.config.*` 这种**代码**一律不放进来（见文件头的界线表）。
 */
export const AI_BUILD_EXCLUDE: readonly string[] = [
  // ── 非代码产物：虚拟环境 / 缓存 / 构建输出（与扫描表**同一份定义**）──
  // 为什么必须在这里也带上：建树骨架 = DEFAULT_SCAN_EXCLUDE + 本表 + 用户配置，
  // 少一边就等于 Python/Rust 生态没排（真机后果见 NON_CODE_ARTIFACT_EXCLUDE 的注释）。
  ...NON_CODE_ARTIFACT_EXCLUDE,
  // ── 测试（含测试资产）────────────────────────────────────
  '**/tests',
  '**/test',
  '**/__tests__',
  '**/__mocks__',
  '**/mocks',
  '**/fixtures',
  '**.test.ts',
  '**.test.tsx',
  '**.test.js',
  '**.test.mjs',
  '**.spec.ts',
  '**.spec.tsx',
  '**.spec.js',
  // ── 示例 / 演示 / 端到端脚本 ────────────────────────────
  '**/examples',
  '**/example',
  '**/demo',
  '**/demos',
  '**/samples',
  '**/sample',
  '**/playground',
  '**/e2e',
  // ── 生成物**本身**（目录、缓存、第三方产物）──────────────
  '**/.render-check',
  '**/.turbo',
  '**/.parcel-cache',
  '**/.next',
  '**/.nuxt',
  '**/.output',
  '**/vendor',
  /**
   * **工具 / 环境产物目录**（0.3.32，独立审查在真机 PEIS 上量出来的）。
   *
   * 修复"裸名不跨目录"之后骨架里**仍有约 22% 是噪声**，前 60 个可见文件里 28 个来自这几个目录
   * ——而它们**一个都不在表里**（`.vscode` 在、`.vs` 不在）。
   *
   * 为什么必须排：骨架预算只有 400 条，这些条目**直接挤掉真实源码**，
   * 而它们对"这个项目是什么"零信息量（真机实测：`.vs` 34 条、`libs` 38、`packages` 38、
   * `TestResults` 25）。
   *
   * ## 收条的界线（这一条我给自己定了规矩，免得把表长成"我见过的垃圾清单"）
   *
   * **只收"跨仓库成立的类别"，不收"某个厂商的目录名"。**
   *
   * - `**\/bin` / `**\/obj` 是 **.NET 生态**的编译输出（语言层面成立）；
   * - `**\/.vs`（VS IDE 缓存）、`**\/TestResults`（测试运行结果）、`**\/packages`（包还原）、
   *   `**\/libs`（原生库/第三方二进制）—— 都是**通用的工具/环境产物类别**，不绑定厂商。
   *
   * **明确不收**的例子：华为 CodeArts 的 `.codeartsdoer`、`.arts`
   * —— 它们是**环境特有**的（只在那台机器/那套工具链上出现），加进来就是拿所有用户的
   * 代码库去背一台机器的偶然事实。这类目录**留给设置页的 `scanExclude`**
   * （它会叠加在这张表之上，是给"我这个仓库特有的排除"准备的）。
   *
   * 判据：**在别的仓库里它也是一类东西吗？** 是 ⇒ 收；只是"我这次见到了" ⇒ 不收。
   */
  '**/.vs',
  '**/TestResults',
  '**/packages',
  '**/libs',
  /**
   * ⚠️ **`**\/bin` / `**\/obj` 必须留着**（.NET 的编译输出）。
   *
   * 真机 PEIS 的 refs 曾大量指向 `PEIS.Web/bin/Debug/*.dll`、`PEIS.Test/bin/Debug/net8.0`、
   * `PEIS.Test/obj/project.assets.json` —— 就是靠这两条修掉的（0.3.31）。
   * 我在 0.3.33 收条时**误删过一次**（替换的换行组合把它们一起带走了），
   * 是"撤掉哪些"的自查清单救回来的 —— 所以这里显式再说明一次它们的依据，
   * 免得下次又有人觉得它们是"某个仓库的名字"而顺手删。
   */
  '**/bin',
  '**/obj',
  // ── 仓库级配置与 IDE/CI 配置（**文件本身**，不含生成它们的代码）──
  '**/.github',
  '**/.vscode',
  '**/.idea',
  '**/.husky',
  // ── 配置文件本身：点名常见的那些，而不是一刀切 `**.json`
  //（一刀切会把 `src/**/*.schema.json` 这类真实数据也挡掉）
  '**/tsconfig**.json',
  '**/jsconfig**.json',
  '**/package.json',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**.lock',
  '**/cordis**.yml',
  '**/cordis**.yaml',
  '**/Dockerfile',
  '**/Makefile',
  '**/.env**',
  '**/.editorconfig',
  '**/.gitignore',
  '**/.npmrc',
  '**/.eslintrc**',
  '**/.prettierrc**',
];

/** 一条工作区相对路径是否被"仅主要代码"这条口径排除（纯函数，可单测）。 */
export function isOutsideMainCode(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return AI_BUILD_EXCLUDE.some((glob) => matchesGlob(path, glob));
}

/**
 * 这条路径是不是**非代码产物**（虚拟环境 / 缓存 / 构建输出 / 日志）。
 *
 * ## 与 `isOutsideMainCode` 的区别（别混用）
 *
 * `isOutsideMainCode` 是**骨架**的口径（"只给主要代码"，连 `tests` / `examples`
 * 都不给模型看）；而节点的 `refs` 允许指向测试、示例这类**真实文件**——
 * 一个"补单元测试"的节点当然该 refs 到 `tests/`。所以校验 refs 时**只**排非代码产物，
 * 不能拿整张建树排除表去卡（那会把合法的测试引用一起丢掉）。
 *
 * 真机现场（2026-10-11）：模型的 refs 直接落库、不过任何校验，于是 `.venv`、
 * `.mypy_cache` 成了节点的 refs —— 正是批次 70 记录过的那类垃圾引用。
 */
export function isNonCodeArtifact(relativePath: string): boolean {
  const path = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return NON_CODE_ARTIFACT_EXCLUDE.some((glob) => matchesGlob(path, glob));
}
