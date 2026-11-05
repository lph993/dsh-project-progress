/**
 * **"这一轮建树到底还在不在跑"**（0.3.64）——纯逻辑，可单测。
 *
 * ## 为什么不能只看本地请求
 *
 * 面板原先用自己那次 `POST /pm/ai/build` 的存活当判据（组件里的 `aiBusy`）。
 * 真机现场：请求被浏览器/代理掐断（`Failed to fetch`，此前实测挂过 11 分 36 秒），
 * `aiBusy` 立刻变回 `false` ⇒ 按钮恢复成"用 AI 建树（直接生成）"，
 * 而**宿主还在逐片落库**，树一直在变。用户原话：
 * "看着生成按钮没变化（没有处于生成中），树却在变化" —— 那一刻他不知道该不该再点一次
 * （再点一次就是白花一整轮的钱），也**找不到停止入口**（它长在那个没被渲染的弹窗里）。
 *
 * ## 三个来源，按可信度排
 *
 * | 来源 | 含义 | 缺失时 |
 * |---|---|---|
 * | `local`（本面板那次请求还在飞） | 最直接的证据 | — |
 * | `board.aiBuildRunning`（宿主事实） | **扫描 / 调模型 / 逐片落库 / 根归位，整段都为真** | 旧宿主没有该字段 |
 * | `board.aiRun.phase === 'running'` | 进度快照还在走（分批时两次调用之间也靠它） | 旧宿主 / 还没开始调模型 |
 *
 * 三者取"或"：任一为真就算在跑。**宁可多显示一次"正在生成"，也不能在树还在变的时候
 * 把按钮恢复成空闲态** —— 后者会诱发"再点一次"的重复花钱。
 */

/** 只看本函数需要的字段（不把整个 BoardSnapshot 拖进来，便于单测与旧宿主降级）。 */
export interface BuildStateSources {
  /** 宿主侧是否真的在跑一轮建树（`BoardSnapshot.aiBuildRunning`；旧宿主缺席）。 */
  aiBuildRunning?: boolean | undefined;
  /** 进度快照（`BoardSnapshot.aiRun`）。 */
  aiRun?: { phase?: 'running' | 'done' | 'error' | undefined } | null | undefined;
}

export function isAiBuildGenerating(localBusy: boolean, board?: BuildStateSources): boolean {
  if (localBusy) return true;
  if (board?.aiBuildRunning === true) return true;
  return board?.aiRun?.phase === 'running';
}

/**
 * **这条结果是不是我刚发起的那一轮**（0.3.70，异步建树的收尾判据）。
 *
 * 异步之后结果走 `board.aiLastBuild`，而它是**服务级全局**的：上一轮的结果会一直留着，
 * 直到下一轮开始。所以必须对时间 —— 只有 `aiLastBuild.at` 不早于我发起的那一刻，才算我的。
 *
 * 容差 2 秒：`at` 由宿主时钟生成、`startedAt` 由浏览器时钟生成，两者本来就可能差几百毫秒；
 * 但**不能放宽到"分钟"** —— 那会把上一轮几分钟前的结果当成本轮的。
 *
 * @param lastBuildAt - 宿主给的发起时刻（ISO 串；可能缺失/不可解析）。
 * @param startedAt - 本面板发起那一刻（epoch 毫秒）。
 */
export function isAiBuildResultFor(lastBuildAt: string | undefined, startedAt: number): boolean {
  if (lastBuildAt === undefined || lastBuildAt === '') return false;
  const at = Date.parse(lastBuildAt);
  if (!Number.isFinite(at)) return false;
  const toleranceMs = 2_000;
  return at + toleranceMs >= startedAt;
}
