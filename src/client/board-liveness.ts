/**
 * **看板快照 → 活跃判据入参** 的唯一翻译处（0.3.11 补）。
 *
 * ## 为什么值得单开一个文件
 *
 * 活跃判据本身是纯函数（`liveness.ts`，有 13 条测试），但它有一个**极易写错**的入参约定：
 *
 * ```
 * activeNodeIds === undefined  →  这个宿主不报该字段（旧宿主）⇒ 走"会话在忙 + 时间窗"兜底
 * activeNodeIds === []         →  宿主报了"这轮没动过任何节点"     ⇒ 一律不转
 * ```
 *
 * 这两个值**语义相反**，而"顺手补个默认值"的写法（`board.activeNodeIds ?? []`）会把它们
 * **压成同一个** —— 后果是**旧宿主上永远不转圈**，也就是用户报的"该转的没转"白修。
 * 这个错误在纯函数测试里抓不到（喂给函数的输入本来就对），必须由**调用方**保证，
 * 而调用方有三个（主画布、画布内部节点、右栏 tab）—— 三处各写一遍迟早漏一处。
 *
 * 所以：**判断只写在这里**，三个消费方都调它，并配一条针对"实参翻译"的测试。
 */
import type { NodeView } from './contract.ts';

/** 活跃判据需要的、与"谁在跑"相关的三个字段（BoardSnapshot 的子集）。 */
export interface LivenessBoardFields {
  /** 正在忙的会话（宿主 `agent/status` 记账）。缺省视为"没有会话在忙"。 */
  busySessionIds?: readonly string[] | undefined;
  /**
   * 这轮真的被忙碌会话动过的节点。
   *
   * ⚠️ **`undefined` 与 `[]` 语义不同**，见本文件顶部说明。
   */
  activeNodeIds?: readonly string[] | undefined;
  /**
   * 忙会话**上一轮**动过的节点（0.3.17）。
   *
   * 与 `activeNodeIds` 分开是刻意的：会话正在读代码/跑命令时这一轮还没写过节点，
   * 这个清单是"**它在跑，上次弄的是这几个**"，用另一种视觉标，**不混进"正在动"**。
   */
  lastTurnNodeIds?: readonly string[] | undefined;
}

/**
 * "上一轮动过"的判定（0.3.17）。
 *
 * 纯粹是集合查找 —— 来源是宿主的事实，客户端**不猜**。缺字段/形状不对一律判"不是"：
 * 这条标记比转圈弱，但也不该在拿不到依据时乱标。
 */
export function isLastTurnNode(
  node: { id?: string | undefined },
  lastTurnNodeIds: readonly string[] | undefined,
): boolean {
  if (node.id === undefined || node.id === '') return false;
  return (lastTurnNodeIds ?? []).includes(node.id);
}

/**
 * 判据函数的**签名别名**（本文件唯一的依赖契约）。
 *
 * 为什么单列一个类型：0.3.13 的类型检查报了 TS2322 —— `liveNodeIdsOf` 声明的回调形状
 * 与 `isLiveNode` 的实际签名不一致（差在可选参数/默认值上）。用同一个别名两边都引，
 * 这类"两处签名各自写一遍"的漂移就不可能再出现。
 */
export type LivenessJudge = (
  node: { id?: string | undefined; lastSessionId?: string | undefined; updatedAt?: string | undefined },
  busy: readonly string[],
  active: readonly string[] | undefined,
) => boolean;

/**
 * `isLiveNode` 的实参形状就是这个——它只**读**两个清单，所以入参一律 `readonly`。
 *
 * 早先 `liveNodeIdsOf` 的回调把 `busy` 写成了可变的 `string[]`，而画布传进来的 prop 是
 * `readonly string[]` ⇒ tsc 报 TS2322（0.3.13 抓出）。判据不改数组，收紧成 `readonly`
 * 才是对的形状；否则每个调用点都得为了"类型好看"而复制一份数组（那是纯粹的浪费）。
 */
export type LivenessNodeLike = {
  id?: string | undefined;
  lastSessionId?: string | undefined;
  updatedAt?: string | undefined;
};

/**
 * 只认**数组**（`Array.isArray`）—— 防的是"JSON 里 `null` vs 字段缺失"这个经典坑：
 * `null` 会被判成"宿主报了这个字段"，然后 `.includes()` 在渲染期直接抛。
 * 宿主正常时不会发 `null`，但这个字段是新增的、且面板每 1 秒解析一次响应，
 * 一次形状异常就够白屏；这里把"形状不对"降级成"当作没报"（走兜底判据，最坏是保守不转）。
 */
function idsOf(value: unknown): string[] | undefined {
  return Array.isArray(value) ? (value as string[]) : undefined;
}

/** 喂给 `isLiveNode` 的两个入参 + "上一轮"清单。 */
export interface LivenessArgs {
  /** 只读即可：判据不会改它（写成 `string[]` 会与只读入参不兼容，0.3.13 由类型检查抓出）。 */
  busySessionIds: readonly string[];
  /** `undefined` = 宿主不报（走兜底）；`[]` = 宿主报了但没有。**消费方不得改写它。** */
  activeNodeIds: readonly string[] | undefined;
  /** 忙会话上一轮动过的节点（0.3.17）。缺省即"没有"：这条标记弱于转圈，少标几个也不会撒谎。 */
  lastTurnNodeIds: readonly string[];
}

/**
 * 把看板快照的字段翻成判据入参。
 *
 * `busySessionIds` / `lastTurnNodeIds` 缺省可以安全地当成 `[]`（"没有"与"字段缺失"后果一致）；
 * `activeNodeIds` **不行**（缺失要走兜底、空数组要一律不转）。
 */
export function livenessArgsOf(board: LivenessBoardFields | undefined): LivenessArgs {
  return {
    busySessionIds: idsOf(board?.busySessionIds) ?? [],
    activeNodeIds: idsOf(board?.activeNodeIds),
    lastTurnNodeIds: idsOf(board?.lastTurnNodeIds) ?? [],
  };
}

/** 便捷包装：直接判某个节点（消费方不必自己拆两个参数，减少写错的机会）。 */
export function liveNodeIdsOf(
  nodes: readonly NodeView[],
  board: LivenessBoardFields | undefined,
  isLiveNode: LivenessJudge,
): Set<string> {
  const { busySessionIds, activeNodeIds } = livenessArgsOf(board);
  return new Set(
    nodes.filter((node) => isLiveNode(node, busySessionIds, activeNodeIds)).map((node) => node.id),
  );
}
