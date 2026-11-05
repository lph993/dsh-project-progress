#!/usr/bin/env node
/**
 * **树验收**（0.3.73 配套的**只读**检查）：一棵"合适"的树长什么样，写成可核对的判据。
 *
 * 为什么要它：此前判断"这棵树行不行"靠感觉 —— 建一次说"不行"、再建一次又说"不行"，
 * 每一轮都是一次模型调用。判据写死在这里以后，**先跑检查、再决定要不要建树**：
 * 结构问题（根太扁、某目录没覆盖）用**搬节点/补节点**解决，零 token；
 * 只有"内容缺失"（某些区域模型根本没看到）才值得再花一轮。
 *
 * 用法：
 *   node scripts/tree-acceptance.mjs --root E:/Go/updater
 *   node scripts/tree-acceptance.mjs --root . --board board.json   # 离线：直接喂看板 JSON
 *
 * 退出码：0 = 全部通过；1 = 有未通过项（逐项打印 PASS/FAIL 与数字）。
 *
 * ## 判据（v1，刻意少而硬）
 *
 * 1. **单根**：父为空的节点恰好 1 个；
 * 2. **每层不摊平**：任意节点的直接子节点 ≤ 8（体检参考上限是 6，这里放宽到 8）；
 * 3. **深度 ≤ 4**：再深就该拆功能点了；
 * 4. **每个顶层目录被覆盖**（`docs/` 默认不算：它是文档，不是功能树；用 `--include-docs` 才算）；
 * 5. **代码文件覆盖率 ≥ 85%**（排除 `docs/`）；
 * 6. **引用卫生**：每个节点都有 refs；没有任何 ref 被两个节点同时认领；没有 stale 节点。
 *
 * 不在这份判据里的（因为无法机械判定、或本来就该由人定）：
 * 名字是否"像功能点"、优先级是否合理、描述是否准确 —— 那些用 `AI 审树` 看，别用建树刷。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const root = argOf('--root', process.cwd());
const boardFile = argOf('--board', undefined);
const includeDocs = args.includes('--include-docs');

/** 判据参数（改这里就是改标准；改之前先想清楚"为什么"）。 */
const LIMITS = {
  maxChildren: 8,
  maxDepth: 4,
  minCodeCoverage: 0.85,
};

const normalize = (path) => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();

async function loadBoard() {
  if (boardFile !== undefined) return JSON.parse(readFileSync(boardFile, 'utf8'));
  const base = process.env.PM_BASE ?? 'http://127.0.0.1:31263';
  const response = await fetch(`${base}/pm/board?root=${encodeURIComponent(root)}`);
  if (!response.ok) throw new Error(`GET /pm/board 失败：${response.status}`);
  return await response.json();
}

function repoFiles(at) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files'], { cwd: at, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

const board = await loadBoard();
const nodes = board.nodes.filter((node) => node.derivedState !== 'removed');
const byId = new Map(nodes.map((node) => [node.id, node]));

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

// 1. 单根
const roots = nodes.filter((node) => node.parentId === null);
check('单根', roots.length === 1, `根节点 ${roots.length} 个${roots.length === 1 ? '' : `（${roots.map((n) => n.name).join(' / ')}）`}`);

// 2. 每层不摊平
const childCount = new Map();
for (const node of nodes) {
  if (node.parentId !== null) childCount.set(node.parentId, (childCount.get(node.parentId) ?? 0) + 1);
}
const widest = [...childCount.entries()].sort((a, b) => b[1] - a[1])[0];
check(
  `每层 ≤ ${LIMITS.maxChildren} 个子节点`,
  (widest?.[1] ?? 0) <= LIMITS.maxChildren,
  widest === undefined ? '无子节点' : `最宽：${byId.get(widest[0])?.name ?? widest[0]} 下 ${widest[1]} 个`,
);

// 3. 深度
const depthOf = (node) => {
  let depth = 0;
  let current = node;
  const seen = new Set();
  while (current.parentId !== null && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentId);
    if (current === undefined) break;
    depth += 1;
  }
  return depth;
};
const maxDepth = Math.max(...nodes.map(depthOf));
check(`深度 ≤ ${LIMITS.maxDepth}`, maxDepth <= LIMITS.maxDepth, `最深 ${maxDepth} 层`);

// 条目覆盖：refs 视为目录前缀或精确文件
const refs = [];
for (const node of nodes) for (const ref of node.refs ?? []) refs.push({ node: node.name, target: normalize(ref.target) });
const isCovered = (path) => refs.some((ref) => path === ref.target || path.startsWith(`${ref.target}/`));

const files = repoFiles(root);
const inScope = (path) => includeDocs || !path.startsWith('docs/');

// 4. 每个顶层目录被覆盖（docs 默认不算）：该目录下**至少有一个文件**落在某个 ref 里
const topDirs = [...new Set(files.filter((file) => file.includes('/')).map((file) => file.split('/')[0]))];
const uncoveredTops = topDirs.filter(
  (top) =>
    inScope(`${top}/x`) &&
    !files.some((file) => file.startsWith(`${top}/`) && isCovered(normalize(file))),
);
check(
  '每个顶层目录都有节点覆盖',
  uncoveredTops.length === 0,
  uncoveredTops.length === 0 ? `${topDirs.length} 个顶层全部覆盖` : `未覆盖：${uncoveredTops.join(' / ')}`,
);

// 5. 代码文件覆盖率
const codeFiles = files.filter((file) => file.includes('/') && inScope(file));
const coveredCode = codeFiles.filter((file) => isCovered(normalize(file)));
const coverage = codeFiles.length === 0 ? 1 : coveredCode.length / codeFiles.length;
check(
  `代码文件覆盖率 ≥ ${(LIMITS.minCodeCoverage * 100).toFixed(0)}%`,
  coverage >= LIMITS.minCodeCoverage,
  `${coveredCode.length}/${codeFiles.length} = ${(coverage * 100).toFixed(1)}%`,
);

// 6. 引用卫生
const noRefs = nodes.filter((node) => (node.refs ?? []).length === 0);
check('每个节点都有 refs', noRefs.length === 0, noRefs.length === 0 ? `${nodes.length} 个节点都有` : `缺 refs：${noRefs.map((n) => n.name).join(' / ')}`);
const shared = [...new Set(refs.map((ref) => ref.target))].map((target) => ({
  target,
  nodes: nodes.filter((node) => (node.refs ?? []).some((ref) => normalize(ref.target) === target)).map((node) => node.name),
})).filter((entry) => entry.nodes.length > 1);
check('同一个 ref 没有被两个节点同时认领', shared.length === 0, shared.length === 0 ? '无重复' : shared.slice(0, 5).map((s) => `${s.target}（${s.nodes.join(' / ')}）`).join('；'));
const stale = nodes.filter((node) => node.stale === true);
check('没有 stale 节点', stale.length === 0, stale.length === 0 ? '无' : `${stale.length} 个：${stale.slice(0, 5).map((n) => n.name).join(' / ')}`);

const passed = results.filter((result) => result.ok).length;
console.log(`\n树验收：${board.projectName ?? '(未命名)'} —— ${passed}/${results.length} 通过\n`);
for (const result of results) {
  console.log(`${result.ok ? '✔' : '✘'} ${result.name} —— ${result.detail}`);
}
const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.log('\n结论：**还不合适**（结构问题优先用搬节点/补节点解决，零 token；别急着重建）。');
  console.log('只有"某个区域模型根本没看到"这类内容缺失，才值得再花一轮建树。');
  process.exitCode = 1;
} else {
  console.log('\n结论：**合适**（结构判据全过；名字/描述是否准确请用「AI 审树」看，不要用建树刷）。');
}
