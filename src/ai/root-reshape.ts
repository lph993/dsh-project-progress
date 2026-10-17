/**
 * **建树前的根整形**：让"项目本体"成为唯一的根（0.3.41）。
 *
 * ## 为什么改在这里，而不是落库后
 *
 * 我先前在**落库后**改父子关系，撞上了领域层两条**正确**的不变量：
 *
 * | 做法 | 结果 |
 * |---|---|
 * | 项目本体提为根 | `C13：项目根唯一`（不许造第二个根） |
 * | 旧根降级到本体下 | `E_CYCLE：不能挂到自己的子孙下面`（旧根正是本体的父） |
 *
 * `E_CYCLE` 是**树的基本性质** —— 只要模型把"项目本体"建成根的**子节点**，
 * 事后就不可能靠"改父子关系"把根换过来。**所以只能改在落库前。**
 *
 * ## 真实形状（我在这一版才搞对）
 *
 * 我第一版以为真机是"两个顶级节点"（存储里确实有过两个并存），于是判据写成
 * "顶级恰好 2 个" ⇒ **在真机上永远不命中**（真机是**一个**根 + 项目本体当它的**子节点**）。
 * 实际的形状是：
 *
 * ```
 * [0] Web 服务端            parent = null      ← 模型选的根（某个端）
 * [1] PEIS 体检管理系统      parent = 0         ← 项目本体（"最像项目名"的那个）
 * [2] 前端界面框架           parent = 0         ← 旧根的其它子节点
 * ...
 * ```
 *
 * ## 判据：**"最像项目名的那个"当根**（不是"同源"）
 *
 * 我第二版用"与项目名同源（公共前缀 ≥ 较短串的 1/2）"，**测试又当场判我错**：
 * 真机上项目自称 `PEIS 体检管理系统`、树里节点叫 `PEIS 体检信息系统` ——
 * 两者只共享 **8** 个字符（`PEIS体检` 之后就在 `管`/`信` 处分叉），谈不上"同源"。
 *
 * 但这里**不需要绝对门槛**，因为比较是**相对的**：在旧根的若干子节点里，
 * **谁与项目名最像**有唯一答案。绝对门槛（≥4 字符）只用来挡住"压根没一个像"。
 *
 * ## 重排做什么
 *
 * - 「最像项目名」的那个子节点 ⇒ **提为根**（`parent = null`），它原来的子树原样保留；
 * - 旧根 ⇒ 变成它的**子节点**（名字保留："这个项目里的一个端"，语义仍成立）；
 * - 旧根的**其余**子节点 ⇒ 移到旧根下面（跟随它们的父，层级不乱）。
 *
 * **一个节点都不丢、一份 refs 都不动，只改层级方向。**
 */

import { projectNamePrefixLength } from '../domain/root-normalize.ts';
import type { AiTree, AiTreeNode } from './parse.ts';

/** 顶级节点至少要与项目名共享这么多字符，才认得出"谁是项目本体"。 */
const MIN_BODY_PREFIX = 4;

export interface RootReshapeResult {
  tree: AiTree;
  /** 是否真的重排过。 */
  reshaped: boolean;
  /** 给人看的说明（进建树 notes）。 */
  note?: string;
}

/**
 * 让"最像项目名的那个"根的子节点当根。**只在判据成立时重排**，否则原样返回。
 */
export function reshapeRootToProjectBody(tree: AiTree, projectName: string): RootReshapeResult {
  const nodes = tree.nodes;
  if (nodes.length < 2) return { tree, reshaped: false };

  /** 前提 ①：顶级**恰好一个**，且它就是下标 0（真机形状）。 */
  const tops: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    if (nodes[index]?.parent === null) tops.push(index);
  }
  if (tops.length !== 1 || tops[0] !== 0) return { tree, reshaped: false };
  const rootNode = nodes[0] as AiTreeNode;

  /**
   * 前提 ②：在"**根本身 + 旧根的直接子节点**"里，找与项目名最像的那一个。
   *
   * ⚠️ **必须把根本身也算进来比**（0.3.44 真机 bug）：真机上根叫「PEIS 体检信息系统」
   * （公共前缀 6）、子节点叫「PEIS 体检管理系统」（前缀 **10**）—— 它才是项目本体。
   * 我原来先判"根自己够像就不动"、再在子节点里挑，于是最像的那个永远没机会当选，
   * 用户看到顶层 5 个节点里 3 个是前端技术件，而真本体被埋在中间。
   *
   * 现在与 `decideRootNormalize` / `decideRootCollapse` 用**同一个口径**：最像的当根。
   */
  const childIndices: number[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index]?.parent === 0) childIndices.push(index);
  }
  if (childIndices.length === 0) return { tree, reshaped: false };

  const rootPrefix = projectNamePrefixLength(projectName, rootNode.name);
  let best: number | null = null;
  let bestPrefix = rootPrefix;
  let tie = false;
  for (const index of childIndices) {
    const prefix = projectNamePrefixLength(projectName, (nodes[index] as AiTreeNode).name);
    if (prefix > bestPrefix) {
      best = index;
      bestPrefix = prefix;
      tie = false;
    } else if (prefix === bestPrefix && best !== null) {
      /** 与当前最优并列（且最优不是根自己）⇒ 歧义。 */
      tie = true;
    }
  }
  /** 前提 ③：得有一个**比根更像**的子节点（否则根本身就是本体，不动）。 */
  if (best === null || bestPrefix < MIN_BODY_PREFIX) return { tree, reshaped: false };
  /** 前提 ④：最像的只能有一个（并列 ⇒ 不动）。 */
  if (tie) return { tree, reshaped: false };
  /** 前提 ⑤：不许与旧根同名（无判据可区分）。 */
  const body = nodes[best] as AiTreeNode;
  if (body.name.trim() === rootNode.name.trim()) return { tree, reshaped: false };

  /**
   * 重排：新数组 = [项目本体, 旧根, 其它旧根子节点…, 其余原序]。
   *
   * 新下标语义：**0 = 项目本体（新根）**，**1 = 旧根**。
   */
  const bodyChildren = nodes
    .map((_, index) => index)
    .filter((index) => index !== 0 && index !== best && nodes[index]?.parent === best);
  const rootOtherChildren = childIndices.filter((index) => index !== best);
  const taken = new Set<number>([0, best, ...bodyChildren, ...rootOtherChildren]);
  const rest = nodes.map((_, index) => index).filter((index) => !taken.has(index));

  const order = [best, 0, ...bodyChildren, ...rootOtherChildren, ...rest];
  const oldToNew = new Map<number, number>();
  order.forEach((oldIndex, newIndex) => oldToNew.set(oldIndex, newIndex));

  const remapped: AiTreeNode[] = order.map((oldIndex) => {
    const node = nodes[oldIndex] as AiTreeNode;
    let parent: number | null;
    if (oldIndex === best) {
      /** 新根。 */
      parent = null;
    } else if (oldIndex === 0) {
      /**
       * 旧根（那个"包装层"）：**降为项目本体的子节点**，并且**只保留自己那一格**。
       *
       * ## 为什么不整枝搬下来（用户口径："**Web服务端没有存在的必要**"）
       *
       * 真机取证：`Web 服务端` 自身只有一条 refs（`PEIS.Web`，**目录本身**），
       * 而它 16 个子节点的 refs 全在 `PEIS.Web/` 之下 —— **父的 refs 是子的前缀**，
       * 说明它不是"一份代码"，而是**替一整片代码取了个层名**（人为包装层）。
       *
       * 它下面那 16 个才是真东西（预约/登记/总检/收费/报表/组织管理…），
       * **它们本来就该直接挂在根下**。整枝搬下来会让它们白多一层包装。
       *
       * 所以：**子节点提一级（挂到新根下），旧根自己退成一个叶**。
       * 不直接删它 —— 删除是破坏性操作，它那条 `PEIS.Web` 引用仍是真信息，
       * 留在树上比悄悄删掉安全（用户想清可以在面板上删）。
       */
      parent = 0;
    } else if (nodes[oldIndex]?.parent === 0) {
      /** 旧根的其余子节点：**提到新根下**（与旧根同级），不再被那个包装层吞掉。 */
      parent = 0;
    } else {
      parent = node.parent === null ? null : (oldToNew.get(node.parent) ?? null);
    }
    return { ...node, parent };
  });

  return {
    tree: { ...tree, nodes: remapped },
    reshaped: true,
    note:
      `**根节点整形**（落库前）：模型把根建成了「${rootNode.name}」，而「${body.name}」才是项目本体 ` +
      `（与项目名共享前 ${bestPrefix} 个字符）⇒ 已重排为：「${body.name}」当根，` +
      `「${rootNode.name}」及其余顶级子节点挂到它下面。**节点一个都没丢**（只改层级方向）。`,
  };
}
