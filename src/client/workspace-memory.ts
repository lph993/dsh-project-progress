/**
 * **看板作用域的记忆**（0.3.7 新增）。
 *
 * ## 用户诉求
 *
 * > "项目进度里切换工作区不能记忆，每次点进去都要重新选。"
 *
 * 0.3.6 的"手动选择"只存在面板组件的 `useState` 里 —— 面板**一卸载**（切到别的视图、
 * 再点回「项目进度」）就没了，于是每次进去都得重选。这不是浏览器缓存问题，
 * 是我把它当成了"临时状态"。
 *
 * ## 记忆的口径（按会话存，不按全局存）
 *
 * 存成 `dsh.pm.scope.<sessionId>`，**跟着会话走**：
 *
 * - **同一个会话里反复进出面板** ⇒ 记住，不必重选（用户要的就是这个）；
 * - **换了会话**（在 DSH 里切到别的工作区，通常会新建会话）⇒ 那份记忆不适用，
 *   面板回到"当前显示的会话所属"这一档 —— 否则"记忆"会把你按在旧工作区上，
 *   那就从"不记忆"变成了另一种错。
 *
 * 这正是 0.3.6 已有的 `stale`（会话变了就丢掉手动选择）语义，只是把载体
 * 从内存换成了 `localStorage`：**同一个会话内跨挂载存活，跨会话自动失效**。
 *
 * ## 为什么"记忆"要排在"当前会话所属"之后，而不是最前
 *
 * 有一条反例必须挡住：用户**刚在 DSH 里切到工作区 B**（会话也换了），
 * 如果记忆（或手选）排在"会话所属"之前，面板会固执地显示 A —— 用户会认为看板坏了。
 * 而按会话存之后这条反例自然不成立（新会话没有记忆）。所以实际优先级是：
 *
 * ```
 * 本会话内你刚选的（含记住的） > 当前会话所属 > 最近变更 > 列表首个
 * ```
 *
 * ## 为什么 UI 偏好可以放 localStorage
 *
 * 与 `flow-canvas.tsx` 的方向/模式/折叠状态同一条纪律：**这是视图偏好，不是事实源**。
 * 事实源（树、进度）在宿主；读不到记忆只是"少一个便利"，绝不能影响看板可用性。
 * 所以读写一律 try/catch，且 `window` 不存在（SSR 自检）时静默跳过。
 */

/** localStorage 键前缀（按会话分）。 */
const SCOPE_STORAGE_PREFIX = 'dsh.pm.scope.';

/** 记忆的载体（便于单测注入假实现；真实调用点是 `window.localStorage`）。 */
export interface KeyValueStoreLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * 取某会话的记忆键；**没有会话 id 就不记忆**。
 *
 * 为什么不给"匿名"也存一份：没有会话上下文时，面板本来就按"最近变更/列表首个"判，
 * 此时存下来的东西属于谁并不明确 —— 存了反而会在下一次有会话时误用。
 */
export function scopeStorageKey(sessionId: string | undefined): string | undefined {
  return sessionId === undefined || sessionId === '' ? undefined : `${SCOPE_STORAGE_PREFIX}${sessionId}`;
}

/**
 * 读回该会话上次选的**工作区路径**。
 *
 * @param store - 存储（真实调用点是 `window.localStorage`；缺省或不可用时返回 `undefined`）。
 * @param sessionId - 当前会话 id。
 * @returns 上次选的路径（规范形式由调用方按 `WorkspaceOption.path` 再比对）；没有则 `undefined`。
 */
export function readRememberedScope(
  store: KeyValueStoreLike | undefined,
  sessionId: string | undefined,
): string | undefined {
  const key = scopeStorageKey(sessionId);
  if (store === undefined || key === undefined) return undefined;
  try {
    const raw = store.getItem(key);
    if (raw === null || raw === '') return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** 写回该会话选的工作区路径（隐私模式/配额满时静默放弃：丢的是偏好，不是数据）。 */
export function writeRememberedScope(
  store: KeyValueStoreLike | undefined,
  sessionId: string | undefined,
  path: string,
): void {
  const key = scopeStorageKey(sessionId);
  if (store === undefined || key === undefined || path === '') return;
  try {
    store.setItem(key, path);
  } catch {
    /* 忽略 */
  }
}

/**
 * 取浏览器 `localStorage`（不存在/不可访问时 `undefined`）。
 *
 * SSR 自检（`scripts/render-check.tsx`）里没有 `window`，隐私模式下访问也可能抛 ——
 * 两种都返回 `undefined`，由上面的读写函数静默降级。
 */
export function browserScopeStore(): KeyValueStoreLike | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    const store = (window as { localStorage?: KeyValueStoreLike }).localStorage;
    return store === undefined ? undefined : store;
  } catch {
    return undefined;
  }
}
