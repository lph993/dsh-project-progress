/**
 * **落点判定**（0.3.56，真机事故驱动；纯函数、可单测）。
 *
 * ## 事故现场（2026-10-21）
 *
 * 用户重生成了 PEIS 的树，结果树上**同时**出现：
 *
 * ```
 * PEIS.Web/Areas/...                          ← PEIS 的
 * src/ai, src/adapter, docs/开发须知.md, lib   ← **插件自己仓库的**
 * ```
 *
 * 而 `pm_20a91cfe`（`E:\thirty\dsh-project-progress` 那个项目）**被改名成了「PEIS」**。
 *
 * 根因：`aiBuildTree` 只 resolve 了 `root`（这次要读的仓库），**落点却用全局
 * `this.projectId`**（由 `operationRoot()` / 陈旧的 `inFlightProject` 锁决定）。
 * 两者不同源时就是"**读 A 仓库、写 B 项目**"：骨架来自 A、节点落进 B、项目名把 B 一起改掉。
 *
 * ## 为什么抽成纯函数
 *
 * 我第一版直接写了一体化的 e2e 想复现那个错配，**结果注入验证时它不变红** ——
 * 前置条件（"绑定真的被拨到另一个仓库"）根本没成立，那条用例是在骗自己。
 * 判定逻辑抽出来之后就能被直接、可靠地测到；`applyAiTree` 只剩几行接线。
 */

/** 根路径归一：大小写、分隔符、尾斜杠在 Windows 上都不该算"不同仓库"。 */
export function normalizeRootForCompare(root: string): string {
  return root
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export interface LandingDecision {
  /** 是否需要"按本次仓库重新绑定"。 */
  rebind: boolean;
  /** 一句话说清为什么（进 notes / 日志）。 */
  reason: string;
}

/**
 * 判断"写之前要不要纠正落点"。
 *
 * @param currentRoot 当前绑定项目的 `workspaceRoot`
 * @param expectRoot 本次建树**真正读的**仓库根
 *
 * 三种情况：
 * - 本次没给 `expectRoot`（调用方没说读的是哪个仓库）⇒ **不判断**（不猜）；
 * - 两边归一后相同 ⇒ 不重绑；
 * - 不同 ⇒ **重绑**（这就是事故那一幕：读 PEIS、写插件仓库的项目）。
 */
export function decideLandingRebind(currentRoot: string, expectRoot: string): LandingDecision {
  const expect = typeof expectRoot === 'string' ? expectRoot.trim() : '';
  if (expect === '') {
    return { rebind: false, reason: '调用方没声明本次读的仓库，不做落点核对' };
  }
  const current = typeof currentRoot === 'string' ? currentRoot.trim() : '';
  if (current !== '' && normalizeRootForCompare(current) === normalizeRootForCompare(expect)) {
    return { rebind: false, reason: '落点与本次仓库一致' };
  }
  return {
    rebind: true,
    reason:
      `落点与本次仓库不一致（项目根「${current || '（空）'}」≠ 本次仓库「${expect}」）` +
      ' ⇒ 按本次仓库重新绑定（否则节点会落进别的仓库的项目，真机上就这样混过一次）',
  };
}
