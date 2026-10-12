/**
 * "这个节点现在**有人在跑**吗" —— 单点判据（纯函数，可单测）。
 *
 * ## 用户给过三次口径，前两次我都做偏了，这里是第三次的结论
 *
 * 1. 「没会话在跑就不用 loading 了，显示播放图标（三角那个）」
 *    → 我实现成"最近 90s 内有写入就转圈"（**时间推测**）。
 * 2. 「正在会话的没有从播放三角切换到 loading」
 *    → 我把宿主给的"会话在忙"信号直接当结论，写成 `if (sessionBusy) return true`（**一票通过**）。
 * 3. 真机截图：「**全在转，但是没有会话在跑吧**」「线路全部都有了动画，而不是正在跑的」
 *    → 一票通过的反面就是：只要用户在跟**任何一个**会话说话，**整棵树**都算在跑。
 *
 * ## 结论：两个条件**同时**成立才算在跑
 *
 * ```
 * 转圈 ⇔ 该节点的 lastSessionId 在 busySessionIds 里  ∧  该节点 updatedAt 很新
 * ```
 *
 * 「节点所属会话在忙」这一条把范围收窄到**这个节点相关的那条会话**（不再整棵树）；
 * 但**只靠它还不够** —— 真机第二次事故（0.3.10 修的就是它）：`session-ce6788ba…`
 * 被宿主报成"在忙"，而它**历史上写过 63 个节点**（建树 + 填进度，全在今早），
 * 于是那 63 个（其中 50 个已完成）**整片转圈**，用户看到的是"不相关的节点也在 loading"。
 *
 * 为什么会这样：`lastSessionId` 回答的是"**谁最近动过它**"，不是"谁**正在**动它"。
 * 一个会话可以忙一整天，而它早上写过的节点跟"此刻在跑"毫无关系。
 * 所以必须有第二个条件把"**此刻**"补上 —— 这就是 `updatedAt` 的用处：
 * 它是**候选**（被这个会话动过）里筛出**刚刚**被动过的那些。
 *
 * 与第一版"只看 updatedAt 窗口"的区别（别再退回去）：那时它**独自**当判据，
 * 会被"别的会话在写"误判；现在它只用来**收窄**一个已经成立的候选集。
 *
 * ## 不知道就显示 ▶
 *
 * 没有会话信息、或时间戳读不出来 ⇒ **不转**。转圈是更强的主张，举证责任在它这边
 * （宁可不转，也不编 —— A3 不许无依据地宣称在跑）。
 */
export interface LivenessInput {
  /**
   * 这个节点**归哪个会话**（宿主记的"最后写它的会话"）。
   *
   * 注意口径：它回答的是"谁最近动过它"，不是"谁正在动它" ——
   * 所以还要与 `busySessionIds`（宿主 `agent/status` 的直接信号）**以及新鲜度**共同判定。
   */
  lastSessionId?: string | undefined;
  /** 该节点最后一次写入时间（宿主的 **UTC** 时间戳串）。缺它就无法判新鲜度 ⇒ 不转。 */
  updatedAt?: string | undefined;
}

/**
 * "刚被写过"的时间窗（毫秒）。
 *
 * 取值的依据：面板轮询间隔是 1s，而模型每步之间通常几秒到几十秒 ——
 * 90 秒足以覆盖"这一步正在动它"，又足以让"几分钟前动过"的节点停下来。
 * 宁可偏严：多转一圈是"无依据地宣称在跑"，少转一圈只是保守。
 */
export const LIVE_FRESH_WINDOW_MS = 90_000;

/**
 * 解析宿主给的 `updatedAt`（**UTC**，形如 `10/12/2026 08:07:16`）。
 *
 * 为什么不用 `Date.parse`：那串是 `MM/DD/YYYY HH:mm:ss` 且**不带时区**，
 * `Date.parse` 在不同引擎里对它的解释不一致（V8 当本地时间），会整体偏掉一个时区，
 * 于是一条"90 秒新鲜度"的判据会在差了 8 小时的机器上彻底失效。这里显式按 UTC 拼。
 *
 * @param raw - 宿主的原始时间戳串。
 * @returns epoch 毫秒；格式不认识时 `undefined`（调用方据此判"不知道 ⇒ 不转"）。
 */
export function parseHostUtcStamp(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (match === null) {
    // 也接受 ISO（`2026-10-12T08:07:16.000Z` / 带偏移）：此时 `Date.parse` 是可靠的
    const iso = Date.parse(raw);
    return Number.isFinite(iso) ? iso : undefined;
  }
  const [, month, day, year, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

/**
 * 该节点此刻是否"有人在跑"（⇒ 转圈 / 连线流动）。
 *
 * @param node 节点的会话归属与最后写入时间
 * @param busySessionIds 宿主报的"正在忙"的会话（`board.busySessionIds`）
 * @param now 当前时刻（epoch 毫秒；注入是为了让测试可复现）
 */
export function isLiveNode(
  node: LivenessInput,
  busySessionIds: readonly string[],
  now: number = Date.now(),
): boolean {
  const own = node.lastSessionId;
  // ① 不知道归谁 ⇒ 不转（不猜）
  if (own === undefined || own === '') return false;
  // ② 那条会话得真的在忙
  if (!busySessionIds.includes(own)) return false;
  /**
   * ③ **还要够新**：那条会话可能已经忙了很久，而它在几小时前写过的节点
   * 与"此刻在跑"无关（真机：一个忙碌会话的 63 个历史节点整片转圈）。
   * 时间戳读不出来 ⇒ 不转（宁可不转，也不编）。
   */
  const stamp = parseHostUtcStamp(node.updatedAt);
  if (stamp === undefined) return false;
  const age = now - stamp;
  // 未来时间戳（时钟漂移）不算"刚刚"：宽容到窗口内即可，超出就按不新鲜处理
  return age <= LIVE_FRESH_WINDOW_MS && age >= -LIVE_FRESH_WINDOW_MS;
}

