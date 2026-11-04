/**
 * "这个节点现在**有人在跑**吗" —— 单点判据（纯函数，可单测）。
 *
 * ## 用户先后给过四次口径，前三次我都做偏了
 *
 * 1. 「没会话在跑就不用 loading 了，显示播放图标（三角那个）」
 *    → 我实现成"最近 90s 内有写入就转圈"（**时间推测**）。
 * 2. 「正在会话的没有从播放三角切换到 loading」
 *    → 我把宿主给的"会话在忙"信号直接当结论（**一票通过**）⇒ 只要有人在跟**任何一个**
 *    会话说话，**整棵树**都算在跑（用户："全在转，但是没有会话在跑吧"）。
 * 3. 「**不相关的节点也在 loading**」⇒ 我加了一道"90 秒内被写过"的窗口，结果
 *    **0 个**节点转圈（用户下一句："**该转的没转**"）。
 * 4. 「loading 应该放到正在跑的会话的**相关节点**上」⇒ 这才是对的判据（本文件当前实现）。
 * 5. 「**正在进行中的任务没有 loading**」（0.3.65）⇒ 我按"`running` + 所属会话在忙"补了一条，
 *    **当天就被真机否掉**：这条规则只对"**上一回合**留下的 running 节点"生效
 *    （本回合写过的节点早已在 `activeNodeIds` 里），所以它唯一的效果就是给**陈旧**的
 *    进行中节点转圈 —— 用户当场看到"updater 工作区里那条 3 周前的节点在转，
 *    可这一回合根本没动过任何节点"。**节点级 loading 只能来自 `activeNodeIds` 这条写入事实。**
 *
 * ## 前三次错在同一个假设（这是本文件最该记住的一条）
 *
 * 我一直想用「节点多久没被写过」推断「有没有人在干它」——**这条路根本走不通**：
 * `updatedAt` 只在**插件工具写节点**时刷新（`pm_add`/`pm_progress`/`pm_report`），
 * 而干活的顺序是"读代码、改代码 → **收尾时**才补记节点"，所以干活途中时间戳本来就是旧的。
 * 真机两个方向都踩过：窗口宽了把 32 小时前写过的 65 个节点转起来、紧了把正在干的掐成 0 个。
 *
 * ## 当前结论：宿主报**事实**，客户端不猜（三条证据）
 *
 * ```
 * ① 它的 refs 里有文件刚被改过（hotNodeIds，0.3.68） → 转
 *    最硬的证据：不是"会话在忙"，而是"这个节点的文件刚才在变"
 * ② 宿主报了 activeNodeIds（哪怕空数组）：
 *      它在清单里 → 转；不在 → **不转**（宿主说没动它，就别拿时间戳去推翻）
 * ③ 宿主没报（旧宿主）：
 *      该节点 lastSessionId 正在忙 ∧ updatedAt 在窗口内 → 转；否则不转
 * ```
 *
 * `activeNodeIds` 由宿主在**写路径的唯一收口**（`patchNode`）记账，与 `busySessionIds`
 * 同源计算 —— 它答的是"这个忙碌会话这一轮真的动过哪些节点"，这正是用户第 4 条口径。
 *
 * **"会话正在跑但没标任何节点"这件事，不属于本文件能回答的问题**：
 * 那是工作区级的"有没有人在干活"，只能另做入口（见 0.3.66 的说明），
 * 不能靠这条判据去猜某个节点 —— 猜错了就是一次假 loading。
 *
 * ## 两条路径必须互斥，不许合并
 *
 * 如果"清单里没有、却因为时间戳新就放行"，那类"几小时前的旧节点整片转圈"会原样回来；
 * 反过来把 `undefined`（宿主不报）和 `[]`（宿主报了但没有）压成同一个值，会让**旧宿主上
 * 永远不转圈**。这个区分由 `board-liveness.ts` 统一翻译、并有专门的测试钉住。
 *
 * ## 不知道就显示 ▶
 *
 * 没有会话信息、或时间戳读不出来 ⇒ **不转**。转圈是更强的主张，举证责任在它这边
 * （宁可不转，也不编 —— A3 不许无依据地宣称在跑）。
 */
export interface LivenessInput {
  /** 节点 id（用来查宿主的"这轮动过"清单 `activeNodeIds`）。 */
  id?: string | undefined;
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
 * 判"**正在被干活**"的时间窗（毫秒）。
 *
 * ## 这道窗口在挡什么
 *
 * 真机现场（两次，方向相反，两个值都是这么定的）：
 *
 * - **窗口太大（等于没有）**：只看"节点所属会话在忙" ⇒ 一个忙碌会话历史上写过的
 *   **65/86** 个节点整片转圈，其中最久的 **32 小时**前写的（用户："不相关的节点也在 loading"）；
 * - **窗口太小（90 秒）**：把"本回合正在干、但还没写节点"的也掐了 ⇒ 实测 **0 个**转圈。
 *   为什么会这样：`updatedAt` 只在**插件工具写节点**时刷新（`pm_add`/`pm_progress`/`pm_report`），
 *   而干活的顺序是"读代码、改代码 → **收尾时**才补记节点"，所以干活途中时间戳本来就旧。
 *
 * ## 取值依据
 *
 * 取"**一个工作步**"的量级：模型一步（读若干文件 + 改若干文件 + 收尾补记）通常在
 * 几十秒到几分钟。10 分钟足以覆盖"这一步正在动它"，而它相对真机那个 32 小时的误报
 * 小了两个数量级 —— 这才是这道窗口的职责：**挡住"很久以前动过"**，不是卡"多久算刚动过"。
 *
 * ## 用户口径（别搞反）
 *
 * 他报的是"**不该转的转了**"，不是"该转的没转"。所以：
 * **宁可少转，也不要把几小时前的节点转起来** —— 转圈是"我正在干这个"的强主张，
 * 举证责任在它这一边（A3）。
 *
 * ## 还能更准（未做）
 *
 * 真正的"本回合动过的"需要宿主在 `agent/status: running` 时记下**回合起点**，
 * 判据变成 `会话在忙 ∧ 节点 updatedAt ≥ 回合起点` —— 那就完全不用猜窗口。
 * 本版没做，是因为它要改宿主面（又一次重启），而当前这道窗口已经能解决用户报的问题。
 */
export const LIVE_FRESH_WINDOW_MS = 10 * 60_000;

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
 * ## 两条路径互斥，取决于**宿主有没有报节点级事实**（0.3.11 定稿）
 *
 * ```
 * 宿主报了 activeNodeIds（哪怕空数组）：
 *     它在清单里 → 转；不在 → **不转**（宿主说没动它，就别拿时间戳去推翻）
 * 宿主没报（旧宿主）：
 *     该节点 lastSessionId 正在忙 ∧ updatedAt 在窗口内 → 转；否则不转
 * ```
 *
 * ## 为什么必须分成两条路径（踩过的坑）
 *
 * `updatedAt` 只在**插件工具写节点**时刷新，而干活的顺序是"读代码、改代码 → **收尾时**
 * 才补记节点"，所以"节点多久没被写过"根本不能代表"有没有人在干它"。用它当判据，
 * 两头都错过：
 *
 * - **宽了**：一个忙碌会话历史上写过的 **65/86** 个节点整片转圈（最久的 32 小时前）
 *   —— 用户："不相关的节点也在 loading"；
 * - **紧了**（90 秒）：本回合正在干但还没补记的也被掐掉，实测 **0 个**转圈
 *   —— 用户："该转的没转"。
 *
 * 所以有节点级事实时**只信事实**；时间窗只在没有事实的旧宿主上兜底。
 * 反过来若"清单里没有、却因为时间戳新就放行"，那第二类误报会原样回来。
 *
 * @param node 节点的会话归属与最后写入时间
 * @param busySessionIds 宿主报的"正在忙"的会话（`board.busySessionIds`）
 * @param activeNodeIds 宿主报的"这轮真的被忙碌会话动过的节点"（`board.activeNodeIds`）；
 *   **`undefined` = 这个宿主不报**（走窗口兜底），空数组 = **报了但没有**（一律不转）
 * @param now 当前时刻（epoch 毫秒；注入是为了让测试可复现）
 */
export function isLiveNode(
  node: LivenessInput,
  busySessionIds: readonly string[],
  /**
   * ⚠️ **刻意不写默认值**（0.3.13 由类型检查抓出）：写成可选参数（`activeNodeIds?`）后，
   * 函数类型与 `liveNodeIdsOf` 声明的回调签名不兼容（tsc 报 TS2322），
   * 而那条"唯一翻译处"的类型契约从没被真正校验过。
   * 调用方**必须显式**给出"宿主报没报这个字段"（`undefined` = 没报）。
   */
  activeNodeIds: readonly string[] | undefined,
  now: number = Date.now(),
  /**
   * **代码文件刚被改过的节点**（0.3.68，宿主按 `git status` + mtime 判定）。
   *
   * 这是三条证据里最硬的一条：它说的不是"会话在忙"，而是"**这个节点的文件刚才在变**"。
   * `undefined` = 宿主不报（旧宿主）⇒ 不影响其它判据。
   */
  hotNodeIds: readonly string[] | undefined = undefined,
): boolean {
  // ── 路径 0：它的代码文件刚被改过 ⇒ 一定在跑 ─────────────────────────
  if (
    hotNodeIds !== undefined &&
    node.id !== undefined &&
    node.id !== '' &&
    hotNodeIds.includes(node.id)
  ) {
    return true;
  }
  const own = node.lastSessionId;
  const ownedByBusy = own !== undefined && own !== '' && busySessionIds.includes(own);
  // ── 路径 A：宿主报了节点级事实 ⇒ 只信它 ─────────────────────────────
  if (activeNodeIds !== undefined) {
    return node.id !== undefined && node.id !== '' && activeNodeIds.includes(node.id);
  }
  // ── 路径 B：旧宿主不报 ⇒ "会话在忙 + 刚被写过"兜底 ──────────────────
  // 不知道归谁 ⇒ 不转（不猜）
  if (!ownedByBusy) return false;
  // 时间戳读不出来 ⇒ 不转（宁可不转，也不编）
  const stamp = parseHostUtcStamp(node.updatedAt);
  if (stamp === undefined) return false;
  const age = now - stamp;
  // 未来时间戳（时钟漂移）不算"刚刚"：宽容到窗口内即可，超出就按不新鲜处理
  return age <= LIVE_FRESH_WINDOW_MS && age >= -LIVE_FRESH_WINDOW_MS;
}

