/**
 * **根节点归位**（0.3.35）。
 *
 * ## 为什么需要它（三次真机重建，三次不同的错法）
 *
 * AI 建树反复把"项目本体"放错位置，而**提示词路线已被证伪**：
 *
 * | 次数 | 根节点 | 项目名在哪 |
 * |---|---|---|
 * | 1 | 移动端外出登记 | **缺失**（整个项目被当成一个移动端子应用） |
 * | 2 | Web 服务端与业务模块 | 根的子节点 |
 * | 3 | Web 服务端与门户 | 根的子节点 |
 *
 * 我为此加过两轮提示词措辞（"根必须是项目本体"、"项目名只能出现在根上"），
 * 每次模型都**换一种错法**。所以这一条不再靠措辞，改成**落库前的确定性归位**。
 *
 * ## 判据（不看仓库名、不看技术栈）
 *
 * 只用"**同一个东西被建成了两个节点**"这个结构事实：
 *
 * 1. 取**项目名**的核心串（去掉括号注释与空白）；
 * 2. 在根的**直接子节点**里找：名字**包含**该核心串的那个；
 * 3. 恰好命中**一个**、且**根自己不包含**该核心串 ⇒ 把它提升为根；
 * 4. 否则**不动**（包括"没有"和"命中多个"两种歧义情形）。
 *
 * 为什么用"候选包含核心串"而不是"相等"：真机上项目的自称有三种写法
 * （`PEIS 体检管理系统` / `PEIS 体检信息系统` / `体检管理系统`），
 * 但它们共享核心串 `PEIS体检` ⇒ 包含关系能稳定命中，相等关系会漏。
 *
 * 为什么要求"根自己不包含"：那说明根**已经是**项目本体（命名不同不算错），不该动。
 */

/** 取名字的核心串：去掉括号注释、空白与常见分隔符。 */
export function coreNameOf(name: string): string {
  return String(name)
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[\s·・\-—_/\\]+/g, '')
    .trim();
}

/** 两个串的最长公共前缀长度。 */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * **候选名是否与项目名"同源"**。
 *
 * ## 为什么不是简单的 `includes`
 *
 * 真机上项目的自称有三种写法，而它们**中间就分叉**：
 *
 * ```
 * 项目名      PEIS体检管理系统
 * 根/子节点   PEIS体检信息系统     ← 公共前缀只有 "PEIS体检"，谁都不包含谁
 * ```
 *
 * `includes` 在这两种写法之间**判不出来**（我第一版就是这么写的，测试当场红了）。
 *
 * ## 判据：最长公共前缀够长，且占较短那个的大部分
 *
 * - 公共前缀 ≥ {@link MIN_COMMON_PREFIX}（4）—— 挡住"都是两个字"就乱命中；
 * - 且 ≥ 较短串长度的 **1/2** —— 挡住"只共享一个泛词"。
 *
 * 拿真机三种写法验（**这些数字就是门槛的来源，不是拍脑袋**）：
 * - `PEIS体检管理系统` vs 同一个 ⇒ 10/10 = 1.0 ✓
 * - 项目名 `PEIS体检管理系统` vs 节点 `PEIS体检信息系统` ⇒ **6/10 = 0.6** ✓
 *   （我第一版门槛写的 2/3 ⇒ 0.6 < 0.667 被挡掉，测试当场红了 —— 门槛必须是 1/2）
 * - `报表系统` vs `系统` ⇒ 前缀 0 ✗（且核心串过短本来就不判）
 */
function isSameOrigin(projectCore: string, candidate: string): boolean {
  const MIN_COMMON_PREFIX = 4;
  const prefix = commonPrefixLength(projectCore, candidate);
  if (prefix < MIN_COMMON_PREFIX) return false;
  const shorter = Math.min(projectCore.length, candidate.length);
  return prefix * 2 >= shorter;
}

/**
 * **两个名字是否"同源"**（对外暴露，供建树前的整形共用同一份判据）。
 *
 * 为什么不各写一份：判据一旦分叉，"落库前整形"与"落库后校验"就会对**同一棵树**
 * 给出不同结论 —— 而"同一件事两处实现"正是我这几轮反复踩的坑。
 */
export function isSameOriginName(projectName: string, candidateName: string): boolean {
  const core = coreNameOf(projectName);
  if (core.length < 4) return false;
  return isSameOrigin(core, coreNameOf(candidateName));
}

/**
 * **两个名字的公共前缀长度**（对外暴露，供"最像项目名的那个"这类判据共用）。
 */
export function projectNamePrefixLength(projectName: string, candidateName: string): number {
  return commonPrefixLength(coreNameOf(projectName), coreNameOf(candidateName));
}

/**
 * **一条名字看起来像"某个端/子应用"吗**（0.3.48 抽出共用）。
 *
 * 原先这段词表**内联在 `applyAiTree` 里**，只用于"建树后提醒根名可疑"。
 * 而树体检（`domain/tree-health.ts`）也要用同一个判断 —— 两处各写一份词表迟早分叉
 * （我这轮已经因为"同一判断两处实现、语义不一致"栽过一次，见 `pickMostLikeProject` 的注释）。
 * 所以收到这里，两处都用它。
 *
 * ⚠️ 词表里的 `Web` 是**窄匹配的代价**：像「PEIS.Web」这种真名也会命中。
 * 所以调用方**不能**单凭它下结论 —— 它只是"可疑信号"，最终判据仍要结合
 * "与项目名的公共前缀"一起看。
 */
const ENDPOINT_WORDS = [
  '移动端',
  '前端',
  '后端',
  '服务端',
  '客户端',
  '网页',
  'Web',
  'Android',
  'iOS',
  '小程序',
  'H5',
];

/** 名字里出现"端/层"这类词 ⇒ 可能是某个端，而不是项目本体。 */
export function looksLikeEndpointName(name: string): boolean {
  return ENDPOINT_WORDS.some((word) => name.includes(word));
}

export interface RootNormalizeCandidate {
  id: string;
  name: string;
}

export interface RootNormalizeDecision {
  /** 要提升为根的子节点 id；`null` = 不动。 */
  promoteId: string | null;
  /** 为什么（进审计与建树 notes）。 */
  reason: string;
  /** 项目名的核心串（诊断用）。 */
  projectCore: string;
}

/**
 * 判断要不要把某个子节点提升为根。
 *
 * 纯函数：只吃"项目名 + 根的直接子节点"，不碰图、不碰存储。
 */
/**
 * 在"根本身 + 它的直接子节点"里挑出**与项目名最像**的那一个。
 *
 * ## 为什么必须是"相对"判据（0.3.44 真机抓到的 bug）
 *
 * 我原来用的是**绝对**门槛：只要"根本身与项目名同源"就**直接不动**。真机上这就错了：
 *
 * ```
 * 项目名  PEIS体检管理系统
 *   根    PEIS体检信息系统    公共前缀 6
 *   子    PEIS体检管理系统    公共前缀 10   ← 它才是项目本体，却被"根自己已够像"挡住了
 * ```
 *
 * 结果是用户看到的树**顶层 5 个节点里有 3 个是前端技术件**，而真正的项目本体
 * 「PEIS 体检管理系统」被埋在中间。**同一轮里 `decideRootCollapse` 用的却是"相对最像"**——
 * 同一个判断两处实现、语义不一致，这是我这轮审查里第二次撞到同一类问题。
 *
 * **现在的唯一口径**：把"根 + 直接子节点"放在一起比，**最像的那个当根**；
 * 根本身最像 ⇒ 不动；子节点最像 ⇒ 它该当根。并列最像 ⇒ 不动（猜错比不动更糟）。
 */
function pickMostLikeProject(
  projectName: string,
  rootName: string,
  children: readonly RootNormalizeCandidate[],
): { winner: RootNormalizeCandidate | 'root' | null; prefix: number; tied: boolean } {
  const core = coreNameOf(projectName);
  const score = (name: string): number => {
    const candidate = coreNameOf(name);
    const max = Math.min(core.length, candidate.length);
    let i = 0;
    while (i < max && core[i] === candidate[i]) i += 1;
    return i;
  };
  const scored: Array<{ ref: RootNormalizeCandidate | 'root'; prefix: number }> = [
    { ref: 'root', prefix: score(rootName) },
    ...children.map((child) => ({ ref: child, prefix: score(child.name) })),
  ];
  let best = scored[0] as { ref: RootNormalizeCandidate | 'root'; prefix: number };
  let tied = false;
  for (const entry of scored) {
    if (entry.prefix > best.prefix) {
      best = entry;
      tied = false;
    } else if (entry.prefix === best.prefix) {
      tied = true;
    }
  }
  return { winner: best.ref, prefix: best.prefix, tied };
}

export function decideRootNormalize(
  projectName: string,
  rootName: string,
  children: readonly RootNormalizeCandidate[],
): RootNormalizeDecision {
  const projectCore = coreNameOf(projectName);
  /** 核心串太短（如项目名就叫「系统」）时不做判断 —— 比较会到处命中。 */
  const MIN_CORE = 4;
  if (projectCore.length < MIN_CORE) {
    return { promoteId: null, reason: `项目名核心串过短（"${projectCore}"），不做归位判断`, projectCore };
  }
  /** "最像项目名"至少要有这么多公共前缀，才认得出本体（挡住"没一个像"）。 */
  const MIN_BODY_PREFIX = 4;
  const pick = pickMostLikeProject(projectName, rootName, children);
  if (pick.prefix < MIN_BODY_PREFIX) {
    return {
      promoteId: null,
      reason: `根与它的 ${children.length} 个子节点里，没有一个与项目名「${projectCore}」有足够公共前缀（最多 ${pick.prefix} 字符）`,
      projectCore,
    };
  }
  if (pick.tied) {
    return {
      promoteId: null,
      reason: `有多个节点与项目名同等相似（公共前缀都是 ${pick.prefix}），分不出本体 ⇒ 不动`,
      projectCore,
    };
  }
  /** 最像的**就是根本身** ⇒ 不动（命名与项目名不完全一致不算错）。 */
  if (pick.winner === 'root') {
    return {
      promoteId: null,
      reason: `根「${rootName}」是与项目名最接近的节点（公共前缀 ${pick.prefix}），无需归位`,
      projectCore,
    };
  }
  const hit = pick.winner as RootNormalizeCandidate;
  return {
    promoteId: hit.id,
    reason:
      `「${hit.name}」比当前根「${rootName}」更接近项目名（公共前缀 ${pick.prefix}）` +
      ` ⇒ 它才是项目本体，应提升为根、原根的其余子节点并入它`,
    projectCore,
  };
}
