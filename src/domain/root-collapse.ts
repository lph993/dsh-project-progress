/**
 * **事后收拢根**（0.3.41）：树已经落库、根选错了，把它扶正。
 *
 * ## 我先前为什么说"做不到"——以及为什么那个结论是错的
 *
 * 我在 0.3.38~0.3.40 试过两条路，都被领域层挡下，于是下了"**现行领域模型下做不到**"的结论：
 *
 * | 做法 | 结果 |
 * |---|---|
 * | 项目本体**提为根** | `C13：项目根唯一`（已有活根时不许再提一个） |
 * | 旧根**降级**到本体下 | `E_CYCLE：不能挂到自己的子孙下面`（旧根正是本体的父） |
 *
 * **错在哪**：我只试了"搬**非根**节点"。而 `mergeRoots()` 早就在用另一条路 ——
 * `reparentSubtree(id, canonical)`：**把"根"挂到另一个"根"下面**。
 * 成环检查是"从新父往上走，看会不会走到自己"，而被搬的是**根**，它的祖先只有它自己
 * ⇒ **永远不成环**；根数 2 → 1 ⇒ **不触发 C13**。
 *
 * 所以正确做法是：**根与根之间可以互换层级**，而"端 → 本体"正是这种情形。
 */

import { projectNamePrefixLength } from './root-normalize.ts';

/** 顶级节点至少要与项目名共享这么多字符，才认得出"谁是项目本体"。 */
const MIN_BODY_PREFIX = 4;

export interface RootCollapseCandidate {
  id: string;
  name: string;
}

export interface RootCollapseDecision {
  /** 要"降级"的旧根（挂到本体下面）。 */
  demoteId: string;
  /** 要"扶为根"的项目本体。 */
  bodyId: string;
  reason: string;
}

/**
 * 决定"该把哪个根降级、让谁当根"。**纯函数**（只吃根列表与项目名，不看图、不看仓库）。
 *
 * 只在"**恰好两个**顶级节点、其中一个明显是项目本体"时给决定；
 * 其余情形一律返回 `null`（歧义不动 —— 猜错比不动更糟）。
 */
export function decideRootCollapse(
  roots: readonly RootCollapseCandidate[],
  projectName: string,
): RootCollapseDecision | null {
  /** 只在**恰好两个**根时动手：一个是要降级的端、一个是本体。 */
  if (roots.length !== 2) return null;
  const [a, b] = roots as [RootCollapseCandidate, RootCollapseCandidate];

  /** 两个根同名 ⇒ 无判据可区分。 */
  if (a.name.trim() === b.name.trim()) return null;

  /** 与项目名更"像"的那个是本体；并列则不判。 */
  const pa = projectNamePrefixLength(projectName, a.name);
  const pb = projectNamePrefixLength(projectName, b.name);
  if (pa === pb) return null;
  /** 得有个"像的"，否则两个都是普通端，不该乱扶。 */
  const bodyPrefix = Math.max(pa, pb);
  if (bodyPrefix < MIN_BODY_PREFIX) return null;

  const body = pa > pb ? a : b;
  const demote = pa > pb ? b : a;
  return {
    demoteId: demote.id,
    bodyId: body.id,
    reason:
      `两个顶级节点「${demote.name}」与「${body.name}」：后者与项目名「${projectName}」` +
      `共享前 ${bodyPrefix} 个字符，是项目本体 ⇒ 把它扶为唯一的根，` +
      `前者作为「这个项目里的一个端」挂到它下面`,
  };
}
