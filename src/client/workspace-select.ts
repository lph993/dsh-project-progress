/**
 * **面板该显示哪个工作区的进度**（0.3.2 新增）。
 *
 * ## 为什么需要这个模块
 *
 * 真机症状（用户原话）："项目进度看板(菜单)，工作区切换不方便，现有的还时灵时不灵"。
 * 查下来的根因是**客户端从来没把"我正在看哪个工作区"告诉宿主**：
 *
 * - 面板读当前会话用的是 `useSessions(state => state.current)`，而 `useSessions` 的源是
 *   `ctx.sessions.list`（`dsh-client-ui-session/lib/client.js:471`），
 *   `SessionListState` 上**根本没有 `current` 字段**（只有 `ids` / `byId` / `phase` /
 *   `projectionsBySession`）⇒ 选择器恒返回 `undefined` ⇒ 请求里**永远不带 `sessionId`**；
 * - 于是宿主只好退回"当前已绑定的工作区根"（`storage.resolution.source = 'bound'`），
 *   也就是**最后一个动过树的那个工作区**。实测对照：
 *
 *   ```
 *   GET /pm/board                   → bound     → E:\WxObj\COP（别人上次动过的）  77 节点
 *   GET /pm/board?sessionId=<本会话> → tool-call → E:\thirty\dsh-project-progress  未命名项目
 *   ```
 *
 * 同一个接口、同一个时刻，两种答案 —— 这就是"时灵时不灵"。
 *
 * ## 现在的口径：**路径说话**
 *
 * 不再猜"宿主觉得我在哪"，而是让**面板自己声明它要哪个工作区**：
 * 客户端本来就有 DSH 的工作区列表（全局标准源 `useWorkspaces`，见
 * `dsh-client-ui-workspace/lib/client.js:4142`），其中 `WorkspaceView` 带 `path` / `workspaceId` /
 * `updatedAt` / `sessionIds`。于是本模块把它归结为"**显式选择 > 我正在看的会话所属 > 最近变更 > 列表首个**"
 * 四级判据，并把**判据名字**一起返回（`source`），界面上如实写出来 ——
 * 用户永远能看出"这个数字是哪个工作区的、为什么是它"，而不是面对一个没有解释的错树。
 *
 * 四级判据的取舍：
 *
 * | 判据 | 为什么排这个位置 |
 * |---|---|
 * | `manual` | 用户刚刚亲手选的，优先级最高（并且要能一直压着自动判据） |
 * | `session` | 当前显示的会话属于哪个工作区 —— 用户在看那个会话，就该看那个工作区的进度。**唯一真正"跟着你走"的判据** |
 * | `recent` | 拿不到会话归属时的兜底：DSH 里切换工作区会写下 `updatedAt`，所以"最近变更"≈"你刚切过去的那个" |
 * | `first` | 全都没有时退回列表首个 —— **仍然是一个确定的工作区**，不是"随便挑一个目录" |
 *
 * 判据**刻意不含"注册表里最近使用的路径"**（宿主侧 `pickWorkspaceFromRegistry` 那种做法）：
 * 那是"别人最近用过哪个"，与"你现在在看哪个"是两件事，真机上正是它把看板带错的。
 */

import { normalizeRootPath } from '../shared/path.ts';

/** `useWorkspaces` 快照里我们真正用到的一行（`WorkspaceView` 的结构子集）。 */
export interface WorkspaceOptionLike {
  readonly workspaceId?: unknown;
  readonly path?: unknown;
  readonly title?: unknown;
  readonly updatedAt?: unknown;
  readonly sessionIds?: unknown;
}

/** 选中理由（界面上原样写出来，见文件头的表）。 */
export type WorkspacePickSource = 'manual' | 'session' | 'recent' | 'first';

/** 一个可选的工作区（已归一化，供下拉直接渲染）。 */
export interface WorkspaceOption {
  /** `workspaceId`（宿主下发的 id；缺失时用路径兜底，保证 React key 稳定）。 */
  key: string;
  /** 规范路径（面板据此请求该工作区的看板）。 */
  path: string;
  /** 显示名：标题优先，没有标题就显示路径末段。 */
  title: string;
  /** ISO 时间戳（排序用；缺失按空串处理，排最后）。 */
  updatedAt: string;
  /** 该工作区记账的会话 id（用于"我正在看的会话属于谁"）。 */
  sessionIds: readonly string[];
}

/** 选中的工作区 + 判据。 */
export interface WorkspacePick {
  option: WorkspaceOption;
  source: WorkspacePickSource;
}

/** 判据的中文说法（界面直接显示，免得每处各写一遍）。 */
export function describeWorkspacePickSource(source: WorkspacePickSource): string {
  switch (source) {
    case 'manual':
      return '你在这个面板里选的';
    case 'session':
      return '当前显示的会话所属';
    case 'recent':
      return '最近变更的工作区';
    default:
      return '列表首个';
  }
}

/**
 * 把 `useWorkspaces` 快照里的行归一化成可选工作区。
 *
 * **只留能用的行**：`path` 必须是非空字符串（没有路径就无从请求看板）；
 * 排序按 `updatedAt` 倒序（最近变更在前），同刻按标题兜底 —— 顺序**必须稳定**，
 * 否则下拉会在轮询刷新时自己跳位置（比排错更让人难受）。
 */
export function toWorkspaceOptions(items: readonly WorkspaceOptionLike[] | undefined): WorkspaceOption[] {
  if (items === undefined) return [];
  const options: WorkspaceOption[] = [];
  for (const item of items) {
    const rawPath = item.path;
    if (typeof rawPath !== 'string' || rawPath.trim() === '') continue;
    const path = normalizeRootPath(rawPath);
    if (path === '') continue;
    const workspaceId = typeof item.workspaceId === 'string' && item.workspaceId !== '' ? item.workspaceId : path;
    const title = typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : tailOf(path);
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : '';
    const sessionIds = Array.isArray(item.sessionIds)
      ? item.sessionIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : [];
    options.push({ key: workspaceId, path, title, updatedAt, sessionIds });
  }
  options.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return options;
}

/** 路径末段（没有标题时当显示名；`E:/a/b` → `b`，根路径原样返回）。 */
function tailOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const at = trimmed.lastIndexOf('/');
  const tail = at === -1 ? trimmed : trimmed.slice(at + 1);
  return tail === '' ? path : tail;
}

/**
 * 选中工作区（纯函数，可单测）。
 *
 * @param options - 已归一化的可选工作区（{@link toWorkspaceOptions} 的产物）。
 * @param currentSessionId - 当前显示的会话 id（拿不到就省略 —— 会退到 `recent`）。
 * @param manualPath - 用户在本面板里显式选过的路径（优先级最高）。
 * @returns 选中的工作区与判据；没有任何可选工作区时返回 `undefined`。
 */
export function pickWorkspace(input: {
  options: readonly WorkspaceOption[];
  currentSessionId?: string | undefined;
  manualPath?: string | undefined;
}): WorkspacePick | undefined {
  const { options } = input;
  if (options.length === 0) return undefined;

  // ① 用户亲手选的（用路径比，容忍大小写/斜杠差异 —— 与项目侧 `isSameRoot` 同一口径）
  const manual = input.manualPath;
  if (manual !== undefined && manual.trim() !== '') {
    const wanted = normalizeRootPath(manual);
    const hit = options.find((option) => option.path === wanted);
    if (hit !== undefined) return { option: hit, source: 'manual' };
  }

  // ② 当前显示的会话属于哪个工作区（唯一"跟着你走"的判据）
  const sessionId = input.currentSessionId;
  if (sessionId !== undefined && sessionId !== '') {
    const hit = options.find((option) => option.sessionIds.includes(sessionId));
    if (hit !== undefined) return { option: hit, source: 'session' };
  }

  /**
   * ③ 兜底：`options` 已按 `updatedAt` 倒序 ⇒ 首个就是"最近变更的工作区"。
   *
   * 这里**不用 `source: 'recent'` 之外的任何猜测**：拿不到会话归属时，
   * "最近变更"是 DSH 里唯一与"你刚切过去"相关的信号（切换会写下 `updatedAt`）。
   */
  const first = options[0];
  if (first === undefined) return undefined;
  return { option: first, source: options.length > 1 ? 'recent' : 'first' };
}

/**
 * 会话列表快照里**我们真正用到的几列**（`SessionSummary` 的结构子集）。
 *
 * ⚠️ 这两列来自**非键控**的全局标准源 `useSessions`（`ctx.sessions.list` 的快照）。
 * 0.3.3 曾经改用一个**键控**钩子（`useSessionRetainInfo`）来判"哪个会话正被显示"，
 * 并在 `useMemo` 里按会话数遍历调用它 —— 那是 React 明令禁止的（Hook 次数必须每次渲染一致），
 * 真机直接抛 `Minified React error #311`、`main` 槽位崩溃、**看板整个打不开**。
 *
 * 教训：**客户端这一层不要去碰键控 Hook**。会话列表 + `cwd` 已经足够回答
 * "我在看哪个工作区的会话"，而且它是稳定的一次订阅。
 */
export interface SessionRowLike {
  readonly sessionId?: unknown;
  readonly cwd?: unknown;
  readonly updatedAt?: unknown;
  readonly origin?: unknown;
}

/**
 * 在**某个工作区**里挑出"最近活跃的会话"。
 *
 * 判据与 `pickWorkspace` 的"会话所属"那一档配合使用：先按 `cwd` 把会话归到工作区，
 * 再取 `updatedAt` 最大的那个 —— 它就是"用户此刻在这个工作区里待着的会话"。
 *
 * 刻意**排除子代理会话**（`origin === 'subagent'`）：那些是某个父会话派生出来的工作线程，
 * 它们也带 cwd，但不是"用户在看的那个会话"；把它们算进来会把面板带到父会话早已离开的工作区。
 *
 * @param option - 目标工作区（用它的 `path` 与会话 `cwd` 做归一化比较）。
 * @param sessionIds - 会话列表快照的 id（顺序即宿主顺序）。
 * @param summaryOf - 取某会话的行（拿不到返回 `undefined`）。
 * @returns 命中会话的 id，或 `undefined`。
 */
export function pickWorkspaceSession(
  option: WorkspaceOption,
  sessionIds: readonly string[],
  summaryOf: (sessionId: string) => SessionRowLike | undefined,
): string | undefined {
  const wanted = option.path;
  let best: { id: string; at: number } | undefined;
  const inWorkspace = new Set(option.sessionIds);
  for (const sessionId of sessionIds) {
    if (sessionId === '') continue;
    const row = summaryOf(sessionId);
    if (row === undefined) continue;
    if (row.origin === 'subagent') continue;
    const cwd = typeof row.cwd === 'string' ? row.cwd : '';
    const rawAt = row.updatedAt;
    const at = typeof rawAt === 'number' && Number.isFinite(rawAt) ? rawAt : 0;

    /**
     * 归属判定：**`cwd` 归一化后相等**为主。会话行的 `cwd` 与工作区 `path` 都来自宿主，
     * 但写法可能不同（盘符大小写 / 斜杠方向），所以一律走 `normalizeRootPath` 比较。
     *
     * 兜底用**工作区自己的会话记账**（`option.sessionIds`）：实测存在 `cwd` 缺失、
     * 或目录被移走后 `cwd` 解析不到的情形。两者取并集 —— 宁可能多认一个，
     * 也不要因为一个字段缺失就直接退到"最近变更"。
     */
    const sameByCwd = cwd !== '' && normalizeRootPath(cwd) === wanted;
    if (!sameByCwd && !inWorkspace.has(sessionId)) continue;
    if (best === undefined || at > best.at) best = { id: sessionId, at };
  }
  return best?.id;
}

/**
 * **会话列表访问面**：`pickWorkspace` 的"会话所属"那一档靠它来判。
 *
 * 为什么不让调用方直接传快照对象：面板只需要"这一档判据要用的那两列"，
 * 把整个 `SessionListState` 传进来会让这个纯函数依赖一个庞大的形状
 * （而它一旦漂移，类型检查也拦不住浏览器里的实现）。
 */
export interface SessionLookup {
  /** 会话 id 列表（宿主顺序）。 */
  ids: readonly string[];
  /** 取某会话的行（拿不到返回 `undefined`）。 */
  summaryOf: (sessionId: string) => SessionRowLike | undefined;
}

/**
 * 用会话列表补出"当前显示的会话 id"（给 `pickWorkspace` 的 `currentSessionId` 用）。
 *
 * 判据顺序：
 * 1. 有 `cwd` 且能归一化匹配的工作区优先 —— **当前工作区**通常就是"我正在那个工作区里干活"；
 * 2. 其余工作区按 `updatedAt` 找各自的最近会话 —— 用户可能停在别的工作区的会话上。
 *
 * @param options - 已归一化的可选工作区（`updatedAt` 已倒序）。
 * @param lookup - 会话列表访问面（缺失时返回 `undefined`）。
 * @returns 命中的会话 id，或 `undefined`。
 */
export function activeSessionFromList(
  options: readonly WorkspaceOption[],
  lookup: SessionLookup | undefined,
): string | undefined {
  if (lookup === undefined) return undefined;
  for (const option of options) {
    const id = pickWorkspaceSession(option, lookup.ids, lookup.summaryOf);
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * 候选会话 id：跨工作区去重、**顺序稳定**（按工作区 `updatedAt` 倒序、再按各工作区的记账顺序）。
 *
 * 为什么留着它：会话与工作区是两套记账，而**"面板该看哪个工作区"这件事必须可复现** ——
 * 顺序不稳会让下拉与判据在轮询刷新时自己跳。它也用在诊断自报里（"有几个候选"）。
 *
 * ⚠️ 它**不是**给键控 Hook 用的：0.3.3 曾拿它去遍历调用 `useSessionRetainInfo`
 * （键控 Hook），Hook 次数随候选数变化 ⇒ React #311 ⇒ 看板打不开。
 * 现在的调用点只把它当**纯数据**用（见 `activeSessionFromList`）。
 *
 * @param options - 已归一化的可选工作区。
 * @returns 去重后的会话 id 列表（可能为空）。
 */
export function candidateSessionIds(options: readonly WorkspaceOption[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    for (const sessionId of option.sessionIds) {
      if (sessionId === '' || seen.has(sessionId)) continue;
      seen.add(sessionId);
      out.push(sessionId);
    }
  }
  return out;
}
