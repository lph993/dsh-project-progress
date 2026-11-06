/**
 * **建树的形状与覆盖**（0.3.74）：把"这棵树合不合适"变成**建树自己会报的数字**。
 *
 * ## 为什么要放进建树流程（而不是靠人每次去看）
 *
 * 真机现场（2026-11-05 updater）：建树报"新建 20、失败 39"，看起来完成了；
 * 实际那棵树**根下挂了 14 支**、代码文件只覆盖 **82.4%**。这两件事当时都是我自己
 * 另外写脚本才算出来的 —— 用户的问题是"到底什么时候算合适"，而插件自己答不上来。
 *
 * 所以建树收尾必须自己算一遍，并把结论写进说明：
 * - **形状**：单根、每层直接子节点 ≤ 6、深度 ≤ 4；
 * - **覆盖**：本次骨架里**文件**条目中，有多少落在某个节点的 refs 里（目标 ≥ 85%）。
 *
 * 它只**报告**，不自动改树 —— 改法只有两种（按功能归拢、补节点），两种都要么花模型调用、
 * 要么动结构，必须让人看见数字之后自己决定。
 */

import type { GraphSnapshot } from '../shared/types.ts';

/** 一个骨架条目（与 `ai/skeleton.ts` 的 `SkeletonEntry` 同形；这里只取用得到的字段）。 */
export interface CoverageEntry {
  path: string;
  kind: 'file' | 'dir';
}

export interface TreeShapeReport {
  roots: number;
  /** 直接子节点最多的那个节点（名字 + 数量）。 */
  widest: { name: string; children: number } | undefined;
  maxDepth: number;
  /** 文件覆盖：骨架里 `kind === 'file'` 的条目。 */
  covered: number;
  files: number;
  coverage: number;
  /** 不合格项（人话，可直接拼进说明）。 */
  failures: string[];
}

const LIMITS = {
  /** 与提示词的硬规则一致（"任何节点的直接子节点不超过 6 个"）。 */
  maxChildren: 6,
  maxDepth: 4,
  /** 覆盖率目标：低于它就不算"合适"。 */
  minCoverage: 0.85,
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

/** refs 覆盖某条路径：完全相等，或 ref 是目录前缀（`refCovers` 的同一口径，简化版）。 */
function covers(target: string, path: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}

/**
 * 计算形状 + 覆盖。
 *
 * @param graph 建完的图（只读）
 * @param entries 本次建树用的骨架条目（**未截断**的那份；分片路径传 `input.entries`）
 */
export function summarizeTreeShape(
  graph: GraphSnapshot,
  entries: ReadonlyArray<CoverageEntry>,
): TreeShapeReport {
  /** 墓碑（`selfState: 'removed'`）不参与形状统计 —— 与看板口径一致。 */
  const nodes = Object.values(graph.nodes).filter((node) => node.selfState !== 'removed');

  const roots = nodes.filter((node) => node.parentId === null).length;
  const children = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
  }
  let widest: { name: string; children: number } | undefined;
  for (const [id, count] of children) {
    const name = graph.nodes[id]?.name ?? id;
    if (widest === undefined || count > widest.children) widest = { name, children: count };
  }

  const depthOf = (id: string): number => {
    let depth = 0;
    let current = graph.nodes[id];
    const seen = new Set<string>();
    while (current !== undefined && current.parentId !== null && !seen.has(current.id)) {
      seen.add(current.id);
      current = graph.nodes[current.parentId];
      if (current === undefined) break;
      depth += 1;
    }
    return depth;
  };
  const maxDepth = nodes.reduce((max, node) => Math.max(max, depthOf(node.id)), 0);

  const refs: string[] = [];
  for (const node of nodes) for (const ref of node.refs ?? []) refs.push(normalizePath(ref.target));
  const files = entries.filter((entry) => entry.kind === 'file');
  const covered = files.filter((entry) => {
    const path = normalizePath(entry.path);
    return refs.some((ref) => covers(ref, path));
  }).length;
  const coverage = files.length === 0 ? 1 : covered / files.length;

  const failures: string[] = [];
  if (roots !== 1) failures.push(`根 ${roots} 个（应为 1 个）`);
  if (widest !== undefined && widest.children > LIMITS.maxChildren) {
    failures.push(`「${widest.name}」下 ${widest.children} 个直接子节点（上限 ${LIMITS.maxChildren}）`);
  }
  if (maxDepth > LIMITS.maxDepth) failures.push(`最深 ${maxDepth} 层（上限 ${LIMITS.maxDepth}）`);
  if (coverage < LIMITS.minCoverage) {
    failures.push(
      `文件覆盖 ${(coverage * 100).toFixed(1)}%（目标 ≥${(LIMITS.minCoverage * 100).toFixed(0)}%）`,
    );
  }
  return { roots, widest, maxDepth, covered, files: files.length, coverage, failures };
}

/** 一行说明（进建树 notes）。**合格时也说**——"合适"本身就是要看的事实。 */
export function describeTreeShape(report: TreeShapeReport): string {
  const shape =
    `树验收：根 ${report.roots} 个 · 最宽 ${report.widest?.children ?? 0} 支` +
    (report.widest !== undefined ? `（「${report.widest.name}」）` : '') +
    ` · 最深 ${report.maxDepth} 层 · 文件覆盖 ${report.covered}/${report.files}` +
    `（${(report.coverage * 100).toFixed(1)}%）`;
  if (report.failures.length === 0) return `${shape} —— **合格**（结构判据全过）`;
  return `${shape} —— **不合格**：${report.failures.join('；')}。修法：按功能归拢（少花 token）或补节点，不要靠重建刷`;
}
