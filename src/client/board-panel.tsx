/**
 * 主面板：项目进度看板（三段式，§11.1）。
 *
 * 三段：① 标题看板（只有百分比与计数）② **流程图**（`FlowCanvas`）③ 状态条（可折叠）。
 * 未完成列表（FR-35）常驻看板下方但默认折叠 —— 中间那一段必须是图，不是清单。
 *
 * 数据来自宿主 HTTP 路由（`/pm/board`），按刷新间隔轮询；
 * 面板不持有权威状态，只做呈现（§12.4：事实源在宿主）。
 */

import { describeBuildFetchFailure } from './build-failure.ts';
import * as React from 'react';

import {
  postAiBuild,
  postAiCancel,
  postNodeAction,
  postRemoveBranch,
  postMergeRoots,
  postNormalizeRoot,
  fetchTreeHealth,
  deleteProject,
  postRollback,
  fetchSnapshots,
  reportClient,
  type AiCacheView,
  type PanelNodeAction,
  type SnapshotRow,
  DERIVED_STATE_COLOR,
  DERIVED_STATE_LABEL,
  fetchBoard,
  formatBasis,
  formatCounts,
  formatPercent,
  nodeRowLabel,
  nodeRowTitle,
  debugUrl,
} from './api.ts';import type { BoardSnapshot, NodeView } from './contract.ts';
import { alertChipOf } from './alerts.ts';
import { nodeCountLabel } from './labels.ts';
import { dismissibleByBackdrop } from './modal-dismiss.ts';
import { legendSections } from './legend.ts';
import { FlowCanvas, type FlowOverlay, type RollbackChoice } from './flow-canvas.tsx';
import { NodeInspector } from './node-inspector.tsx';
import {
  activeSessionFromList,
  pickWorkspace,
  toWorkspaceOptions,
  type SessionRowLike,
  type WorkspaceOption,
  type WorkspaceOptionLike,
  type WorkspacePick,
} from './workspace-select.ts';
import { WorkspaceSwitcher } from './workspace-switcher.tsx';
import { livenessArgsOf } from './board-liveness.ts';
import {
  browserScopeStore,
  readRememberedScope,
  writeRememberedScope,
} from './workspace-memory.ts';

const { useCallback, useEffect, useMemo, useRef, useState } = React;

/**
 * 作用域自报用的 panelId。
 *
 * 与主面板的上报（`panelId: 'project-manager'`）**刻意不同**：后者带 `registeredSlots`，
 * 是"槽位注册成功"的记录；这一条只讲"面板看哪个工作区、凭什么"。
 * 分开写的好处是**后到的上报不会把槽位清单覆盖成空数组**（`state.client` 是单槽位记录）。
 */
const PANEL_ID_REPORT_SCOPE = 'project-manager-scope';

/** 构建期注入的版本号（见 tsdown 的 `define`）。 */
declare const __PM_VERSION__: string | undefined;

/**
 * `useSessions` 标准钩子的结构类型（`SnapshotSelectorHook<SessionListState>` 的最小面）。
 *
 * ⚠️ **这个快照里没有 `current`**（只有 `ids` / `byId` / `phase` / `projectionsBySession`，
 * 见 `dsh-api-session-controller` 的 `SessionListState`）。0.3.1 读的就是不存在的 `state.current`，
 * 于是恒为 `undefined` ⇒ 面板从不声明作用域 ⇒ "看板看错工作区"。
 * 现在只用**确实存在**的两列：`ids` 与 `byId[*].cwd` / `updatedAt`。
 */
export type SessionsSelectorHook = <T>(
  selector: (state: {
    ids?: readonly string[];
    byId?: Readonly<Record<string, SessionRowLike | undefined>>;
  }) => T,
) => T;

/**
 * `useWorkspaces` 标准钩子的结构类型（`SnapshotSelectorHook<WorkspaceSnapshot>` 的最小面）。
 *
 * 它给出 DSH 自己的**工作区列表**（`items` 里每行带 `workspaceId` / `path` / `title` /
 * `updatedAt` / `sessionIds`）。面板据此声明"我要哪个工作区" —— 见 `workspace-select.ts`。
 */
export type WorkspacesSelectorHook = <T>(selector: (state: { items?: readonly unknown[] }) => T) => T;

/**
 * 面板组件 props（`PropsRuntime<'main'>` + 注入面）。
 *
 * `useSessions` / `useWorkspaces` **都不需要**我们注入：它们是 DSH 的**全局标准源**
 * （`GlobalStandardProps`），由渲染器把 `{...kit}` 摊进每个 slot 条目的 props
 * （`standardHookPropName('workspaces') === 'useWorkspaces'`，见
 * `dsh-client-ui-renderer`；二者的 `provideRoot` 分别在 `dsh-client-ui-session:469` 与
 * `dsh-client-ui-workspace:4142`）。
 *
 * ⚠️ **0.3.1 在这里读错过字段**：当时用 `useSessions(state => state.current)` 取"当前会话"，
 * 而该标准源的快照是 `SessionListState`，**没有 `current`** ⇒ 恒为 `undefined` ⇒ 面板从来没把
 * 自己的作用域告诉宿主，宿主只好用"最后绑过的那个工作区" ⇒ 用户看到的就是"时灵时不灵"。
 * 现在作用域改由**工作区路径**表达（面板本来就拿得到），会话 id 只作补充。
 */
export interface BoardPanelProps {
  /** 刷新间隔（毫秒），由宿主设置同步。 */
  intervalMs?: number;
  /** 会话列表选择器钩子（全局标准源；缺失时为 undefined）。 */
  useSessions?: SessionsSelectorHook;
  /** 工作区列表选择器钩子（全局标准源；缺失时退回"宿主自己解析"）。 */
  useWorkspaces?: WorkspacesSelectorHook;
}

/**
 * 局部错误边界：**把"空白"变成"看得见的报错"**。
 *
 * 为什么必须有：槽位错误边界只会在主区域留下一个空 div（`data-slot-error`），
 * 用户看到的就是"点开一片空白"，既不知道该刷新还是该反馈。
 * 这里兜住画布的渲染异常，退化成一条可读的错误 + 说明，并上报到宿主诊断。
 */
class CanvasBoundary extends React.Component<
  { children?: React.ReactNode; onError: (error: Error) => void },
  { failure: string | undefined }
> {
  constructor(props: { children?: React.ReactNode; onError: (error: Error) => void }) {
    super(props);
    this.state = { failure: undefined };
  }

  static getDerivedStateFromError(error: unknown): { failure: string } {
    return { failure: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error): void {
    this.props.onError(error);
  }

  override render(): React.ReactNode {
    if (this.state.failure !== undefined) {
      return React.createElement(
        'div',
        { style: { padding: 16, fontSize: 12, lineHeight: 1.7 } },
        React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '流程图渲染失败'),
        React.createElement('div', { style: { opacity: 0.8 } }, this.state.failure),
        React.createElement(
          'div',
          { style: { opacity: 0.7, marginTop: 6 } },
          '看板数据仍然是好的：可展开上方「未完成 N 项」列表继续用；' +
            '这个错误已上报宿主，可在 /pm/debug 的「客户端 bundle」里查看堆栈。',
        ),
      );
    }
    return this.props.children;
  }
}

/**
 * 标准源缺失时的替身：不订阅、恒返回 undefined。
 *
 * 这里仍然调用一个 Hook（`useState`），是为了让 Hook 调用**次数**在
 * "标准源出现/消失"时保持一致——渲染器缓存了 standard kit，
 * 正常不会变，但保持次数稳定能避免潜在的 Hook 顺序问题。
 *
 * ## ⚠️ 参数形状必须与真 Hook 的 selector 一致（0.3.13 由类型检查抓出）
 *
 * 原先这里写的是 `(state: { current?: string }) => T` —— 那是**更早一版**的猜测形状
 * （当时以为快照里有 `current`，而实际上 `SessionListState` 根本没有它）。
 * 于是 `props.useSessions ?? useAbsentSessions` 求值出的联合类型与真 selector 不兼容，
 * 调用点访问 `state.ids` 直接报 TS2339。**类型检查红了很久没人发现，因为
 * `node --test` 只 strip 类型、不做类型检查。**
 */
export function useAbsentSessions<T>(
  _selector: (state: {
    ids?: readonly string[];
    byId?: Readonly<Record<string, SessionRowLike | undefined>>;
  }) => T,
): T | undefined {
  useState(undefined);
  return undefined;
}

/** `useWorkspaces` 缺失时的替身（同上：保持 Hook 次数稳定、形状与真 Hook 一致）。 */
export function useAbsentWorkspaces<T>(
  _selector: (state: { items?: readonly unknown[] }) => T,
): T | undefined {
  useState(undefined);
  return undefined;
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    // 用 `minHeight` 而不是定高 `height`：面板容器未必是定高 flex，
    // 定高会在内容撑不开时把中间的画布压成 0 像素（实测表现为"点开一片空白"）
    minHeight: '100%',
    fontSize: 13,
    color: 'var(--dsw-alias-text-primary, inherit)',
  },
  board: {
    padding: '12px 16px',
    borderBottom: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
  },
  titleRow: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' as const },
  projectName: { fontSize: 15, fontWeight: 600 },
  metrics: { display: 'flex', gap: 20, flexWrap: 'wrap' as const },
  metric: { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  metricLabel: { fontSize: 11, opacity: 0.65 },
  metricValue: { fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  band: { display: 'flex', gap: 1, height: 10, alignItems: 'stretch', marginTop: 2 },
  bandCell: { width: 4, borderRadius: 1 },
  /** 空工作区引导（无树时占据流程图那一段）。 */
  emptyWrap: { flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px 24px' },
  // ── 未完成清单弹窗（用户反馈"改为modal形式"）────────────────────
  // 用 fixed 覆盖整个视口：画布高度不再随列表开合变化（内联展开会把流程图挤下去）
  modalBackdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 60,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    // 主题色跟着宿主走（暗色下白底卡片会刺眼）；拿不到变量时回落到一个中性深色
    background: 'var(--dsw-alias-bg-primary, #1f2126)',
    color: 'inherit',
    border: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.28))',
    borderRadius: 10,
    padding: '12px 14px',
    width: 'min(760px, 94vw)',
    maxHeight: '78vh',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
  },
  modalHeader: { display: 'flex', alignItems: 'center', gap: 10 },
  modalTitle: { fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' as const },
  modalClose: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    fontSize: 18,
    lineHeight: '18px',
    cursor: 'pointer',
    padding: '0 4px',
  },
  modalBody: { overflow: 'auto', display: 'flex', flexDirection: 'column' as const },
  /**
   * AI 建树的**实时进度条**（FR-167）。
   *
   * 底色用中性灰、**只在真的被截断时**才换成红 —— 红在本项目专供"删除/异常"，
   * 不借给"进度条快满了"这种普通状态（否则画布上的红框就不再意味着"要删东西"）。
   */
  aiRunTrack: {
    height: 6,
    marginTop: 4,
    borderRadius: 3,
    background: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
    overflow: 'hidden' as const,
  },
  aiRunFill: { height: '100%', background: '#94a3b8', transition: 'width 120ms linear' },
  /**
   * 模态框里的**可滚动正文**。
   *
   * 为什么必须有：AI 建树的结果里带着整份 notes（几十条"某节点优先级初判…"），
   * 实测直接**把弹窗撑出屏幕**、底下的按钮点不到（用户口径："生成后的文字溢出 modal，没有滚动"）。
   * 给一个相对视口的最大高度 + 自动滚动，长内容就不再挤坏布局。
   */
  modalScroll: {
    maxHeight: '46vh',
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
  },
  // ── 图例弹窗的分节排版（符号一栏定宽、说明一栏自适应）────────────
  legendSection: { marginBottom: 10 },
  legendSectionTitle: { fontSize: 12, fontWeight: 600, marginBottom: 2 },
  legendRow: { display: 'flex', gap: 10, alignItems: 'baseline', padding: '1px 0' },
  legendGlyph: {
    flex: '0 0 auto',
    minWidth: 54,
    textAlign: 'center' as const,
    fontVariantNumeric: 'tabular-nums',
    opacity: 0.9,
  },
  legendMeaning: { flex: 1, minWidth: 0 },
  rowSelected: { background: 'rgba(37,99,235,0.14)', borderRadius: 4 },
  confirmBox: {
    marginTop: 6,
    padding: '8px 10px',
    borderRadius: 4,
    fontSize: 12,
    background: 'rgba(239,68,68,0.10)',
    border: '0.5px solid rgba(239,68,68,0.5)',
  },
  /** AI 建树入口行（FR-39；成本提示与按钮同排）。 */
  aiBar: { display: 'flex', alignItems: 'center', marginTop: 6, flexWrap: 'wrap' as const },
  toggleLabel: { fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, opacity: 0.8 },
  headerButton: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 4,
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  statusBar: {
    borderTop: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.24))',
    background: 'var(--dsw-alias-bg-secondary, transparent)',
  },
  /** 状态条的第一行：折叠开关 + 警示角标（第二行是展开后的正文）。 */
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  statusToggle: {
    flex: '1 1 auto',
    minWidth: 0,
    textAlign: 'left' as const,
    fontSize: 11,
    padding: '5px 12px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  statusBadge: {
    fontSize: 10,
    padding: '0 5px',
    borderRadius: 8,
    border: '0.5px solid currentColor',
    opacity: 0.85,
  },
  /**
   * FR-174 的警示角标（可点，去诊断页）。
   *
   * 颜色是**semantic**的、不借装饰：红 = 异常（与"删除"共用同一支红色语义），
   * 灰 = 只需知情（降级/兜底）。这里刻意不用黄 —— 黄是"完成但有遗留"的专属色。
   */
  alertChip: {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    margin: '0 12px 0 2px',
    padding: '0 6px',
    borderRadius: 8,
    fontSize: 10,
    lineHeight: '16px',
    textDecoration: 'none',
    cursor: 'pointer',
  },
  alertChipError: {
    color: '#ef4444',
    border: '0.5px solid #ef4444',
    background: 'rgba(239,68,68,0.10)',
  },
  alertChipWarn: {
    color: 'inherit',
    border: '0.5px solid currentColor',
    opacity: 0.7,
  },
  alertAck: {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 11,
    lineHeight: '12px',
    padding: '0 0 0 2px',
  },
  statusBody: { maxHeight: 200, overflow: 'auto' },
  sectionTitle: { fontSize: 12, fontWeight: 600, margin: '16px 0 6px', opacity: 0.8 },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 6px',
    borderRadius: 4,
    lineHeight: 1.5,
  },
  dot: { width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto' },
  rowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  badge: {
    fontSize: 10,
    padding: '1px 5px',
    borderRadius: 8,
    border: '0.5px solid currentColor',
    opacity: 0.85,
    flex: '0 0 auto',
  },
  note: { fontSize: 11, opacity: 0.7, lineHeight: 1.6 },
  warn: {
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 4,
    background: 'rgba(245,158,11,0.12)',
    border: '0.5px solid rgba(245,158,11,0.5)',
  },
  error: {
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 4,
    background: 'rgba(239,68,68,0.12)',
    border: '0.5px solid rgba(239,68,68,0.5)',
  },
  empty: { padding: 24, textAlign: 'center' as const, opacity: 0.7, lineHeight: 1.8 },
  /** 中段：画布 + 属性栏并排（属性栏固定宽度，画布吃掉剩余空间）。 */
  middle: { display: 'flex', flex: '1 1 auto', minHeight: 0, alignItems: 'stretch' },
  canvasSlot: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0 },
};

/**
 * 轮询看板数据。面板是"只读投影"，因此轮询足够，无需长连接。
 *
 * @param intervalMs - 轮询间隔（毫秒，下限 500）。
 * @param sessionId - 当前会话 id（可选，交给宿主做会话记账与旧逻辑兜底）。
 * @param rootPath - **要看哪个工作区**（0.3.2 新增）。不给就退回旧行为：
 *   宿主按"当前已绑定的工作区根"解析，也就是**最后一个动过树的那个** ——
 *   那正是"时灵时不灵"的来源，所以面板正常路径上总是给。
 */
export function useBoardData(
  intervalMs: number,
  sessionId?: string,
  rootPath?: string,
): {
  board: BoardSnapshot | undefined;
  error: string | undefined;
  refresh: () => void;
} {
  const [board, setBoard] = useState<BoardSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);

  // 作用域切换：立刻丢掉上一棵项目树的投影，避免短暂显示"别人的看板"。
  useEffect(() => {
    setBoard(undefined);
  }, [sessionId, rootPath]);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void fetchBoard(undefined, sessionId, rootPath)
      .then((outcome) => {
        if (outcome.ok && outcome.value) {
          setBoard(outcome.value);
          setError(undefined);
        } else {
          setError(outcome.error ?? '未知错误');
        }
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, [sessionId, rootPath]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, Math.max(500, intervalMs));
    return () => window.clearInterval(timer);
  }, [refresh, intervalMs]);

  return { board, error, refresh };
}

/**
 * 面板外壳：只负责"取数据"，渲染全部交给 {@link BoardView}。
 *
 * 拆开的原因（实测踩过）：整块逻辑挤在一起时，`board` 还没到就崩不出来的 bug
 * （TDZ）在自检里根本覆盖不到 —— 因为自检没法给组件喂假数据。
 * 现在 `BoardView` 只吃 props，自检可以直接把"有数据的看板"喂进去，
 * 于是"拿到数据就崩"这类问题在 `pnpm run verify` 就会被挡住。
 */
export function BoardPanel(props: BoardPanelProps): React.ReactElement {
  /**
   * **作用域判据链**（0.3.2 修复"时灵时不灵"的核心）：
   *
   * 1. 读 DSH 自己的工作区列表（`useWorkspaces`）；
   * 2. 从**非键控**的会话列表（`useSessions`）里按 `cwd` 找出"我正在那个工作区里待着的会话"；
   * 3. 归结成"显式选择 > 会话所属 > 最近变更 > 列表首个"（`pickWorkspace`），
   *    并把判据名字显示在界面上。
   *
   * ⚠️ **不要在这里引入任何"键控 Hook"**（`useSessionRetainInfo` 那类）：0.3.3 用过它，
   * 并按会话数可变次数调用 ⇒ React #311 ⇒ `main` 槽位崩溃、看板打不开。详见下面那段注释。
   *
   * 手动选择（`pickedPath`）要能一直压着自动判据，所以放在 state 里而不是每次重算；
   * 但**用户在选择器里换工作区后会失效**（`activeSessionId` 变了就丢掉它）——
   * 否则面板会永远钉在用户很久以前手选的那个工作区上。
   */
  const useSessions = props.useSessions ?? useAbsentSessions;
  const useWorkspaces = props.useWorkspaces ?? useAbsentWorkspaces;

  const items = useWorkspaces((state) => state.items) as readonly WorkspaceOptionLike[] | undefined;
  const options = useMemo(() => toWorkspaceOptions(items), [items]);
  /**
   * **当前会话 id —— 只走非键控的全局标准源 `useSessions`**（0.3.4 修的 React #311）。
   *
   * 0.3.3 曾经改用**键控**钩子 `useSessionRetainInfo` 来判"哪个会话正被主区域显示"，
   * 并在 `useMemo` 里按会话数**可变次数**地调用它 —— React 的 Hook 次数必须每次渲染一致，
   * 于是它抛 `Minified React error #311`（"Rendered more hooks than during the previous render"），
   * `main` 槽位整条崩掉、**看板打不开**。
   *
   * 现在改用会话列表快照里的 `cwd` + `updatedAt`（`activeSessionFromList`）：
   * 一次订阅、无键控 Hook、纯函数可单测。
   */
  const sessionIds = useSessions((state) => state.ids) as readonly string[] | undefined;
  const rowsById = useSessions((state) => state.byId) as
    | Readonly<Record<string, SessionRowLike | undefined>>
    | undefined;
  const sessionLookup = useMemo(
    () =>
      sessionIds === undefined
        ? undefined
        : {
            ids: sessionIds,
            summaryOf: (sessionId: string) => rowsById?.[sessionId],
          },
    [sessionIds, rowsById],
  );
  const activeSessionId = useMemo(
    () => activeSessionFromList(options, sessionLookup),
    [options, sessionLookup],
  );
  /**
   * 会话变了（用户切了工作区/会话）⇒ 丢掉手动选择。
   *
   * 用 **state 而非 ref** 记录"上一个是哪个会话"，这样丢弃动作发生在渲染期、
   * 与手动选择同一次提交里，不会有"先按旧选择发一轮请求"的窗口。
   *
   * **初值从 `localStorage` 读回**（0.3.7）：以前只存在内存里，面板一卸载
   * （切到别的视图再点回来）就没了 —— 用户原话："切换工作区不能记忆，每次点进去都要重新选"。
   * 记忆按**会话**存（`dsh.pm.scope.<sessionId>`），于是"跨挂载记住、跨会话自动失效"
   * 与既有的 `stale` 语义完全一致。
   */
  const [picked, setPicked] = useState<{ path: string; forSession: string | undefined } | undefined>(
    () => {
      const remembered = readRememberedScope(browserScopeStore(), activeSessionId);
      return remembered === undefined
        ? undefined
        : { path: remembered, forSession: activeSessionId };
    },
  );
  const stale = picked !== undefined && picked.forSession !== activeSessionId;
  const manualPath = stale ? undefined : picked?.path;

  const pick = useMemo(
    () =>
      pickWorkspace({
        options,
        ...(activeSessionId !== undefined ? { currentSessionId: activeSessionId } : {}),
        ...(manualPath !== undefined ? { manualPath } : {}),
      }),
    [options, activeSessionId, manualPath],
  );

  /**
   * 这里**刻意不再调 `useSessions` 取"当前会话"**（0.3.13 清掉一处死代码 + 一处类型错误）。
   *
   * 原先写的是 `useSessions((state: { current?: string }) => state.current)` —— 但
   * `SessionListState` 快照里**根本没有 `current` 字段**（0.3.5 那次"看板看错工作区"的
   * 根因就是它恒为 `undefined`）。于是这行：
   * - 运行期永远拿不到值，纯属噪声；
   * - 类型上还报 TS2345（参数形状与真 selector 不兼容）——**类型检查红了很久没人发现**，
   *   因为 `node --test` 只 strip 类型、不做类型检查。
   *
   * 当前会话 id 由 `activeSessionId`（保留计数那条链）给出，就够了。
   */
  const scopeSessionId = activeSessionId;
  /**
   * **把"作用域是怎么定的"报给宿主**（0.3.2）。
   *
   * 为什么值得单独上报：这一整条判据链（哪些标准源到位、选中哪个工作区、凭什么）
   * 全在浏览器里，而它出问题时的表现是"看板看错工作区" —— 宿主只看到一个**没带参数**的请求，
   * 与"旧客户端"无法区分。0.3.2 的真机排查就卡在这一步：日志里全是 `GET /pm/board`（无参数），
   * 只能靠猜"是不是某个标准源没到位"。有了这条，`/pm/debug` 直接给出答案。
   *
   * 只在判据真正变化时上报（依赖是一个把判据压平的字符串），不让诊断变成轮询噪声。
   */
  const scopeKey = `${options.length}|${pick?.option.path ?? ''}|${pick?.source ?? ''}|${
    activeSessionId ?? ''
  }`;
  useEffect(() => {
    reportClient({
      panelId: PANEL_ID_REPORT_SCOPE,
      bundleId: 'dsh-project-progress',
      registeredSlots: [],
      scope: {
        workspaceCount: options.length,
        ...(pick !== undefined ? { pickedPath: pick.option.path, source: pick.source } : {}),
        hooks: {
          workspaces: props.useWorkspaces !== undefined,
          sessions: props.useSessions !== undefined,
        },
        ...(activeSessionId !== undefined ? { activeSessionId } : {}),
      },
    });
  }, [scopeKey]);
  const { board, error, refresh } = useBoardData(
    props.intervalMs ?? 1000,
    scopeSessionId,
    pick?.option.path,
  );
  return React.createElement(BoardView, {
    board,
    error,
    refresh,
    sessionId: scopeSessionId,
    workspacePick: pick,
    workspaceOptions: options,
    onSelectWorkspace: (option: WorkspaceOption) => {
      /**
       * **选完立刻写回记忆**（0.3.7），而不是等卸载时再存：
       * 面板可能被直接关掉/刷新，那时没有"卸载回调"的机会。
       */
      writeRememberedScope(browserScopeStore(), activeSessionId, option.path);
      setPicked({ path: option.path, forSession: activeSessionId });
    },
  });
}

/**
 * **模块级会话导航注册表**（用户诉求："点击能跳转到对应会话" + "从未完成节点发起会话"）。
 *
 * 为什么不用 props 一层层传：主面板 `BoardView` 与右栏 `RightProgressTab` 是**两个独立 slot**，
 * 后者能收到 `inject`，前者收不到 —— 而属性栏两边都要用这两个能力。
 * 用模块级注入（与 `legend.ts` 的共享常量同一套路）比给两个 slot 各接一遍 props 更不容易漏。
 *
 * 由 `client/index.tsx` 在插件装配时 `setSessionNavigation(...)` 写入；
 * **没写入就是 undefined** ⇒ 属性栏那一行退化成纯文本，绝不画点了没反应的按钮。
 */
export interface SessionNavigationHandle {
  openSession(sessionId: string): void;
  startSession(): void;
}

let sessionNavigation: SessionNavigationHandle | undefined;

/** 注入会话导航能力（`index.tsx` 调用；宿主没提供时不要调，保持 undefined）。 */
export function setSessionNavigation(handle: SessionNavigationHandle | undefined): void {
  sessionNavigation = handle;
}

/** 读取会话导航能力（属性栏渲染时调用）。 */
export function getSessionNavigation(): SessionNavigationHandle | undefined {
  return sessionNavigation;
}

export interface BoardViewProps {
  board: BoardSnapshot | undefined;
  error: string | undefined;
  refresh: () => void;
  sessionId: string | undefined;
  /** 本次看板作用域落在哪个工作区、为什么（0.3.2）。 */
  workspacePick?: WorkspacePick | undefined;
  /** 可选工作区（下拉内容）。 */
  workspaceOptions?: readonly WorkspaceOption[] | undefined;
  /** 用户把面板切到另一个工作区。 */
  onSelectWorkspace?: ((option: WorkspaceOption) => void) | undefined;
  /**
   * **跳到某个会话**（用户诉求："点击能跳转到对应会话"）。
   *
   * 由 `index.tsx` 从宿主 `uiWorkspace.openSession` 包一层注入。不提供时属性栏那一行退化成纯文本
   * —— **不做点了没反应的按钮**。
   */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /**
   * **用新会话开始处理**（用户诉求："从未完成节点发起会话进行开始处理的能力"）。
   *
   * 同样由 `index.tsx` 注入（`uiWorkspace.startSession`）。**注意它只是"开一个空会话"** ——
   * 插件不能替新会话预填要做什么（DSH 没这个 API），所以按钮文案必须如实说明这一点。
   */
  onStartSession?: (() => void) | undefined;
}

/** 未完成清单弹窗的入参（抽成独立组件：SSR 自检可以直接渲染它，不需要测试专用开关）。 */
export interface UnfinishedListModalProps {
  nodes: NodeView[];
  selectedId?: string;
  onPick: (nodeId: string) => void;
  onClose: () => void;
}

/**
 * 未完成清单（FR-35/36）—— **弹窗**形态。
 *
 * 为什么不是内联展开：看板中间那段必须是**流程图**，内联列表一展开就把图挤下去
 * （用户实测反馈"改为modal形式"）。弹窗化后画布高度恒定，列表还能更宽更高。
 * 关闭方式与回滚浮层/右键菜单同一套习惯：Esc、点背景、右上角 ×。
 */
export function UnfinishedListModal(props: UnfinishedListModalProps): React.ReactElement {
  // Esc 关闭（只在客户端跑；SSR 不执行 effect，因此不会碰 document）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  return React.createElement(
    'div',
    {
      style: styles.modalBackdrop,
      role: 'presentation',
      onClick: () => props.onClose(),
    },
    React.createElement(
      'div',
      {
        style: styles.modalCard,
        role: 'dialog',
        'aria-modal': true,
        'aria-label': '未完成清单',
        // 点卡片内部不该关掉弹窗（否则选行时手一抖就没了）
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
      },
      React.createElement(
        'div',
        { style: styles.modalHeader },
        React.createElement('span', { style: styles.modalTitle }, `未完成 ${props.nodes.length} 项`),
        React.createElement(
          'span',
          { style: { ...styles.note, flex: 1 } },
          '点一行即选中该节点并关闭本窗口（口子数按 FR-35 的口径：只列未完成叶节点）',
        ),
        React.createElement(
          'button',
          { type: 'button', style: styles.modalClose, onClick: () => props.onClose(), title: '关闭（Esc）' },
          '×',
        ),
      ),
      props.nodes.length === 0
        ? React.createElement('div', { style: styles.note }, '所有叶节点都已完成。')
        : React.createElement(
            'div',
            { style: styles.modalBody },
            props.nodes.map((node) =>
              React.createElement(
                'div',
                {
                  key: node.id,
                  id: `pm-row-${node.id}`,
                  style: {
                    ...styles.row,
                    ...(props.selectedId === node.id ? styles.rowSelected : {}),
                  },
                  onClick: () => props.onPick(node.id),
                },
                React.createElement('span', {
                  style: {
                    ...styles.dot,
                    background: DERIVED_STATE_COLOR[node.derivedState] ?? '#999',
                  },
                }),
                React.createElement(
                  'span',
                  { style: styles.rowName, title: nodeRowTitle(node) },
                  nodeRowLabel(node),
                ),
                node.focus ? React.createElement('span', { style: styles.badge }, '关注') : null,
                node.addedMidway
                  ? React.createElement('span', { style: styles.badge }, '中途新增')
                  : null,
                node.autoCreated ? React.createElement('span', { style: styles.badge }, '自动') : null,
                node.subscriptionCount > 0
                  ? React.createElement('span', { style: styles.badge }, `订阅 ${node.subscriptionCount}`)
                  : null,
                React.createElement(
                  'span',
                  { style: styles.badge },
                  DERIVED_STATE_LABEL[node.derivedState] ?? node.derivedState,
                ),
                // 数字口径与画布/属性栏同源：枝给「总 / 已完成」，叶给自身百分比
                React.createElement(
                  'span',
                  { style: { ...styles.note, fontVariantNumeric: 'tabular-nums' } },
                  nodeCountLabel(node),
                ),
              ),
            ),
          ),
    ),
  );
}

/**
 * **图例弹窗**（用户反馈："不用在 tooltip 上展示每个图标或者 `自` 介绍，可以写到专门的地方，
 * 在哪合适你自己定"）。
 *
 * 放哪儿的三选一（自己定的）：① 状态条里堆一行文字 —— 原来就是这么做的，太长没人看，
 * 而且和节点框里那几个符号对不上号；② 设置页 —— 离画布太远，看图时不会去翻；
 * ③ **标题栏一个「图例」按钮 + 弹窗** ← 选了它：就在看板上、一步可达、能分节讲清楚
 * （完成态 / 状态 / 数字口径 / 连线 / 操作入口），且与「未完成清单」共用同一套弹窗习惯。
 */
export function CanvasLegendModal(props: { onClose: () => void }): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  return React.createElement(
    'div',
    { style: styles.modalBackdrop, role: 'presentation', onClick: () => props.onClose() },
    React.createElement(
      'div',
      {
        style: styles.modalCard,
        role: 'dialog',
        'aria-modal': true,
        'aria-label': '流程图图例',
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
      },
      React.createElement(
        'div',
        { style: styles.modalHeader },
        React.createElement('span', { style: styles.modalTitle }, '流程图图例'),
        React.createElement(
          'span',
          { style: { ...styles.note, flex: 1 } },
          '符号与说明同源（client/legend.ts）：改了画法就会改这里，不会出现"图例里没这个符号"',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            style: styles.modalClose,
            onClick: () => props.onClose(),
            title: '关闭（Esc）',
          },
          '×',
        ),
      ),
      React.createElement(
        'div',
        { style: styles.modalBody },
        legendSections().map((section) =>
          React.createElement(
            'div',
            { key: section.title, style: styles.legendSection },
            React.createElement('div', { style: styles.legendSectionTitle }, section.title),
            section.note !== undefined
              ? React.createElement('div', { style: styles.note }, section.note)
              : null,
            section.entries.map((entry) =>
              React.createElement(
                'div',
                { key: `${section.title}:${entry.glyph}:${entry.meaning}`, style: styles.legendRow },
                React.createElement('span', { style: styles.legendGlyph }, entry.glyph),
                React.createElement('span', { style: styles.legendMeaning }, entry.meaning),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** 纯呈现：三段式布局（FR-40）+ 交互状态。不取数据，因此可被自检直接渲染。 */
export function BoardView(props: BoardViewProps): React.ReactElement {
  const { board, error, refresh, sessionId } = props;
  const empty = board !== undefined && board.nodes.length === 0;
  // 三段式布局（FR-40）：① 标题看板 ② 流程图 ③ 状态条。
  // 未完成列表按 FR-35 常驻看板下方，但默认折叠 —— 中间那段必须是**流程图**，
  // 否则用户看到的是一份文件/节点清单（实测反馈）。
  const [showList, setShowList] = useState(false);
  /** 图例弹窗（用户反馈：符号含义要"写到专门的地方"）。 */
  const [showLegend, setShowLegend] = useState(false);
  /** 整理为单一根的结果/原因（显示在标题区下方，不弹窗）。 */
  const [rootNotice, setRootNotice] = useState<string | undefined>(undefined);
  /**
   * 删除项目的两段式状态：先拿影响范围（`preview`），**再点一次同一项**才真删。
   *
   * 为什么不用 `window.confirm`：这份面板其余破坏性操作都走"面板自己的确认框"，
   * 混进一个浏览器原生弹窗既不一致、也没法写清"到底删掉了多少节点"。
   */
  const [projectDelete, setProjectDelete] = useState<
    { projectId: string; preview: string } | undefined
  >(undefined);
  /**
   * **删除请求正在飞**（0.3.37，用户反馈："点击后没有锁页面，好像在删除过程中能点其他地方"）。
   *
   * 三个作用：① 防重入（不可逆操作不许重复提交）；
   * ② 弹窗按钮禁用并改文案（让人看到"在删"）；
   * ③ 遮罩点了也不关 —— 那一刻关掉只会让人以为"取消了"，而请求已经发出去了。
   *
   * ⚠️ 但**第一次点击到拿到影响范围之间**这一段没有锁：那时还没有确认框，
   * 用户看到的仍是普通面板。那是"预览"阶段，可取消、无副作用，不上锁是合理的。
   */
  const [deleting, setDeleting] = useState(false);
  const [hideDone, setHideDone] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  /**
   * FR-174：已"知悉"的最近一条 error 的时间戳。
   *
   * 为什么要能知悉：诊断缓冲区是**有界保留**的，一条转瞬即逝的错误会一直躺在里面，
   * 于是红标就永远挂着 —— 那和"线路全在转"是同一类毛病（用户看不到"现在到底有没有事"）。
   * 判据用**时间戳**而不是条数：缓冲区回卷时条数会变小，用条数会让"明明还有错"被判成已清。
   * 只存组件状态、不落盘：刷新页面后重新示警是对的（日志里确实还有那条错）。
   */
  const [alertsAckedAt, setAlertsAckedAt] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // 注意：`selectedId` 必须先声明再使用。曾经把这一行写在 useState 之上，
  // 结果是"加载态正常、拿到数据就崩"（`board?.nodes.find` 里踩 TDZ，
  // ReferenceError: Cannot access 'selectedId' before initialization）——
  // SSR 只渲染了 board 为 undefined 的分支，所以完全没暴露（实测踩过）。
  const selectedNode = board?.nodes.find((node) => node.id === selectedId);
  /** 活得着的顶级节点（parentId === null 且不是墓碑）—— 用于「整理为单一根」入口。 */
  const liveRootCount = (board?.nodes ?? []).filter((node) => node.parentId === null && node.derivedState !== 'removed').length;
  /**
   * FR-158 ③：疑似遗留的节点数（上次建树没再提到、但仍照常计入统计）。
   *
   * 放在看板规模行里报出来：这个信号的用处是"提示你去决定它们的去留"，
   * 只标在单个节点上、用户翻不到，就等于没标。
   */
  const staleCount = (board?.nodes ?? []).filter(
    (node) => node.stale === true && node.derivedState !== 'removed',
  ).length;
  /** FR-174：宿主侧的错误/告警角标（口径见 `client/alerts.ts`；没警示时是 undefined）。 */
  const alertChip = alertChipOf(board?.alerts, alertsAckedAt);
  /** 删除确认框（FR-57 的面板路径）：先 preview，用户在面板内确认后才落库。 */
  const [removePrompt, setRemovePrompt] = useState<{ nodeId: string; preview: string } | undefined>(
    undefined,
  );
  const [removeError, setRemoveError] = useState<string | undefined>(undefined);
  /**
   * AI 建树的确认框（FR-39b：**先给成本，再决定是否花 token**）。
   *
   * 面板按钮 → 先要预估（不调模型）→ 显示"发多少、几次调用、约多少 token" →
   * 用户点确认才真正发起。模型侧走不到这条路径（那里必须过 `ctx.approval`，fail-closed）。
   */
  const [aiPrompt, setAiPrompt] = useState<
    // `cache` 可缺席（旧宿主不返回该字段）：UI 按"未知"渲染，绝不因此崩
    { description: string; route: string; cache?: AiCacheView } | undefined
  >(undefined);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiResult, setAiResult] = useState<string | undefined>(undefined);
  const [aiError, setAiError] = useState<string | undefined>(undefined);
  /** 是否先清掉上次自动建出的草稿（默认是：阶段 B 改写阶段 A 的骨架）。 */
  /**
   * 「先清掉上次自动生成的草稿」。
   *
   * **默认关**（2026-09-25 真机纠正）：早先默认开、还写着"推荐"，而真机实测它与**幂等收敛相反** ——
   * 勾了它 ⇒ 上次那批草稿**先被删** ⇒ 本轮提案**找不到可复用的身份锚点**（FR-158 的身份键/引用重叠匹配
   * 全部落空）⇒ 全部按"新建"处理，模型换说法的几条就变成**额外的枝**：实测**节点数 99 → 129**。
   * 增量重建（不勾）才会复用既有节点、让树收敛。
   */
  const [aiReplaceDraft, setAiReplaceDraft] = useState(false);
  /** 忽略缓存强制重算（T6 逃生口）：默认关闭，勾了必然花钱。 */
  const [aiForceRebuild, setAiForceRebuild] = useState(false);

  /**
   * 右键菜单动作的三种落地方式（FR-6.6）：
   * ① 直接执行（关注/取消关注/继续/放行）；② 先填文本（添加/改名/描述）；
   * ③ 先看影响范围再确认（暂停/拦停/打回滚点）。确认人是面板前的用户（§6.7f 第 2 行）。
   */
  const [menuText, setMenuText] = useState<
    { action: PanelNodeAction; nodeId: string; label: string } | undefined
  >(undefined);
  const [menuInput, setMenuInput] = useState('');
  const [menuConfirm, setMenuConfirm] = useState<
    { action: PanelNodeAction; nodeId: string; label: string; preview: string } | undefined
  >(undefined);
  const [menuNotice, setMenuNotice] = useState<string | undefined>(undefined);
  const [menuError, setMenuError] = useState<string | undefined>(undefined);

  /** 执行一个菜单动作（`needs-confirm` 时转为确认框，不直接落库）。 */
  const runNodeAction = useCallback(
    (action: PanelNodeAction, nodeId: string, extra?: { text?: string; confirm?: boolean }) => {
      setMenuError(undefined);
      void postNodeAction({
        action,
        nodeId,
        ...(extra?.confirm === true ? { confirm: true } : {}),
        ...(extra?.text !== undefined ? { text: extra.text } : {}),
      }).then((outcome) => {
        if (!outcome.ok || !outcome.value) {
          setMenuError(outcome.error ?? '未知错误');
          return;
        }
        const value = outcome.value;
        if (value.status === 'needs-confirm') {
          const labels: Record<string, string> = { pause: '暂停', hold: '拦停', snapshot: '打回滚点' };
          setMenuConfirm({
            action,
            nodeId,
            label: labels[action] ?? action,
            preview: value.preview ?? '（无影响范围说明）',
          });
          return;
        }
        if (value.status === 'denied') {
          setMenuError(value.message ?? '被拒绝');
          return;
        }
        const detail = value.detail;
        const suffix =
          detail !== undefined && typeof detail['handoff'] === 'string'
            ? `（交接文档 ${detail['handoff']}）`
            : detail !== undefined && typeof detail['snapshot'] === 'string'
              ? `（回滚点 ${detail['snapshot']}）`
              : '';
        setMenuNotice(`${value.message ?? '已完成'}${suffix}`);
        refresh();
      });
    },
    [refresh],
  );

  // 说明：`handleNodeAction` 依赖 `askRemove`（删除走独立路径），
  // 因此它必须定义在 `askRemove` 之后 —— 这一块整体放在文件靠下的位置。


  /** 第一步：要成本预估（不花 token）。 */
  /**
   * 第一步：**直接建树**（0.3.21，用户口径："不再做 token 预算，直接 AI 生成树和修复维护树"）。
   *
   * 原先这里先发一次 `confirm: false` 只取估价、弹窗让用户确认花费，再发第二次才真建。
   * 现在**一次调用直接建**，两个开关（清草稿 / 强制重算）改为常显，点击时按当前勾选取值。
   *
   * 注意：取消的是**花钱闸门**；`pm_remove` 那类**破坏性操作审批**仍然保留（用户明确要求）。
   */
  const askAiBuild = useCallback(() => {
    setAiError(undefined);
    setAiResult(undefined);
    setAiBusy(true);
    void postAiBuild({
      // 直接建（服务端 0.3.21 起：不传 confirm 或传 true 都表示"建"）
      confirm: true,
      replaceAutoDraft: aiReplaceDraft,
      ...(aiForceRebuild ? { forceRebuild: true } : {}),
      ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    })
      .then((outcome) => {
        if (!outcome.ok || !outcome.value) {
          /**
           * **连接断了不等于建树失败**（0.3.63，真机现场）。
           *
           * 判定收在纯函数 `describeBuildFetchFailure` 里（另一端有单测），
           * 这里只负责"拿事实 → 按结论呈现"。
           */
          const raw = outcome.error ?? '未知错误';
          void fetchBoard()
            .then((board) => {
              const verdict = describeBuildFetchFailure({
                error: raw,
                ...(board.ok && board.value
                  ? {
                      board: {
                        runPhase: board.value.aiRun?.phase,
                        nodeCount: board.value.nodes.length,
                      },
                    }
                  : {}),
              });
              if (verdict.kind === 'completed') {
                setAiResult(verdict.message);
                refresh();
                return;
              }
              setAiError(verdict.message);
            })
            .catch(() => setAiError(describeBuildFetchFailure({ error: raw }).message));
          return;
        }
        const value = outcome.value;
        if (value.status === 'denied') setAiError(`${value.hint}（${value.reason}）`);
        else if (value.status === 'error') setAiError(value.message);
        /**
         * 旧宿主仍可能回 `needs-confirm`（它是两段式实现）⇒ 退回"弹窗让用户确认"的老路，
         * 而不是把这条回复当成意外错误。这样面板在新旧宿主上都能用。
         */
        else if (value.status === 'needs-confirm') {
          setAiPrompt({ description: value.description, route: value.route, cache: value.cache });
        }
      })
      .finally(() => setAiBusy(false));
  }, [aiForceRebuild, aiReplaceDraft, sessionId]);

  /** 第二步：用户确认后真的调模型。 */
  const confirmAiBuild = useCallback(() => {
    setAiBusy(true);
    setAiError(undefined);
    void postAiBuild({
      confirm: true,
      replaceAutoDraft: aiReplaceDraft,
      ...(aiForceRebuild ? { forceRebuild: true } : {}),
      ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    })
      .then((outcome) => {
        if (!outcome.ok || !outcome.value) {
          setAiError(outcome.error ?? '未知错误');
          return;
        }
        const value = outcome.value;
        if (value.status === 'ok') {
          // **不清 aiPrompt**：模态框要留着显示结果（用户口径：结果用 modal 呈现，点空白关不掉）
          setAiResult(
            `AI 建树完成：新建 ${value.created} 个、更新 ${value.updated} 个` +
              (value.removed > 0 ? `、清掉草稿 ${value.removed} 枝` : '') +
              `（模型提出 ${value.proposed} 个节点）` +
              (value.failures.length > 0 ? `，失败 ${value.failures.length} 个` : '') +
              // 走缓存时明说：否则用户会以为又花了一次钱（旧宿主不给 cache 就不提）
              (value.cache?.state === 'hit'
                ? `\n本次命中缓存，没有调用模型（省约 ${value.cache.savedTokens ?? 0} token）。`
                : value.cache?.state === 'resume'
                  ? `\n本次复用上次被中断的结果，没有调用模型。`
                  : '') +
              (value.notes.length > 0 ? `\n说明：${value.notes.join('；')}` : ''),
          );
          refresh();
          return;
        }
        if (value.status === 'denied') setAiError(`${value.hint}（${value.reason}）`);
        else if (value.status === 'error') {
          // 一并显示模型的原始输出片段：否则"找不到 JSON"这类报错完全看不出原因（实测踩过）
          setAiError(
            value.rawText !== undefined && value.rawText.trim() !== ''
              ? `${value.message}\n模型原始输出片段：${value.rawText.slice(0, 300)}`
              : value.message,
          );
        } else setAiError('仍在待确认状态：请重新点击。');
      })
      .finally(() => setAiBusy(false));
  }, [aiForceRebuild, aiReplaceDraft, refresh, sessionId]);

  /**
   * **关闭 AI 模态框**（显式动作）。
   *
   * 三个状态一起清：确认内容、结果、错误 —— 少清一个就会出现"关掉又弹回来"的怪现象。
   */
  const closeAiModal = useCallback(() => {
    setAiPrompt(undefined);
    setAiResult(undefined);
    setAiError(undefined);
  }, []);

  /**
   * **中止正在跑的那次调用**（FR-168，用户口径："执行中…只能明确点取消或关闭"）。
   *
   * 走宿主的显式取消通道（`POST /pm/ai/cancel`），**不靠"连接断了"这类推断**。
   * 已经拿到的输出会被宿主存成续跑缓存 ⇒ 下次能接着用，不白花。
   */
  const cancelAiBuild = useCallback(() => {
    void postAiCancel()
      .then((outcome) => {
        setAiError(
          outcome.ok && outcome.value?.cancelled === true
            ? '已请求中止这次调用：正在等模型侧收尾，已拿到的输出会存成续跑缓存。'
            : '没有正在跑的调用（可能刚结束）。',
        );
      })
      .catch(() => setAiError('取消请求发送失败（宿主路由不可用）。'));
  }, []);

  /**
   * 选中节点 / **取消选中**（`nodeId === undefined`，由画布"点空白处"触发）。
   *
   * 用户口径："点击空白区域取消选中节点，节点属性展示处清空"。
   * 属性面板是靠 `selectedId` 驱动的：清掉它，右栏自然回到"未选中"的引导态，
   * 不需要额外清一次状态（一处真源，避免两个地方各清一半）。
   */
  const selectNode = useCallback((nodeId: string | undefined) => {
    setSelectedId(nodeId);
    if (nodeId === undefined) return;
    // 列表现在是**弹窗**：选中节点不该顺手把弹窗弹出来（那正是"图被挤下去"的老毛病）。
    // 若此刻弹窗恰好开着（用户在里面点行），把该行滚进视野即可。
    window.requestAnimationFrame(() => {
      document.getElementById(`pm-row-${nodeId}`)?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  /** 第一步：拿删除影响范围（不落库）。 */
  const askRemove = useCallback((nodeId: string) => {
    setRemoveError(undefined);
    void postRemoveBranch({ nodeId, policy: 'record', confirm: false }).then((outcome) => {
      if (!outcome.ok || !outcome.value) {
        setRemoveError(outcome.error ?? '未知错误');
        return;
      }
      if (outcome.value.status === 'needs-confirm') {
        setRemovePrompt({ nodeId, preview: outcome.value.preview });
        return;
      }
      if (outcome.value.status === 'denied') {
        setRemoveError(outcome.value.message ?? outcome.value.reason ?? '被拒绝');
      }
    });
  }, []);

  /** 第二步：用户在面板内确认后执行。 */
  const confirmRemove = useCallback(() => {
    if (!removePrompt) return;
    void postRemoveBranch({ nodeId: removePrompt.nodeId, policy: 'record', confirm: true }).then(
      (outcome) => {
        if (!outcome.ok || !outcome.value) {
          setRemoveError(outcome.error ?? '未知错误');
          return;
        }
        if (outcome.value.status === 'denied') {
          setRemoveError(outcome.value.message ?? outcome.value.reason ?? '被拒绝');
          return;
        }
        setRemovePrompt(undefined);
        setSelectedId(undefined);
        refresh();
      },
    );
  }, [removePrompt, refresh]);

  /**
   * 删除当前项目（两段式）。
   *
   * 第一下：拿影响范围（`confirm:false`，服务端只回预览、不落库）并显示出来；
   * 第二下（同一项目）：真删。删的是**当前显示**的项目时服务端会**自愈** ——
   * 同一个工作区根立刻得到一个全新的空项目（`reboundProjectId`），
   * 所以"删了再建"一步到位，不会静默换到别的工作区。
   */
  const doDeleteProject = useCallback(() => {
    const projectId = board?.projectId;
    if (projectId === undefined || projectId === '') return;
    /**
     * **防重入**（0.3.37，用户反馈："删除过程中能点其他地方"）。
     *
     * 删除是**不可逆**的，请求还在飞的时候绝不能再来一次：
     * 之前没有这道闸门 ⇒ 连点两次「确认删除」会发两次真删请求（第二次打的是刚被删掉的项目，
     * 只会失败，但"能重复提交"本身就是不该有的行为）。
     */
    if (deleting) return;
    const pending = projectDelete?.projectId === projectId ? projectDelete : undefined;
    if (pending !== undefined) setDeleting(true);
    void deleteProject(
      pending !== undefined ? { projectId, confirm: true } : { projectId },
      undefined,
      sessionId,
    ).then((outcome) => {
      setDeleting(false);
      const value = outcome.value;
      if (value === undefined) {
        setRootNotice(`删除项目失败：${outcome.error ?? '未知错误'}`);
        setProjectDelete(undefined);
        return;
      }
      if (value.status === 'needs-confirm') {
        /**
         * 第一步只拿到影响范围 ⇒ **开弹窗**（0.3.24）。
         *
         * 原先这里只 `setRootNotice(preview)` 并改按钮文案成"再点一次确认删除" ——
         * 那就是用户说的"没有取消操作"：想反悔只能再点一下，而那一按就是真删。
         * `rootNotice` 仍然写一份（弹窗关掉后还能从提示行看到上次的影响范围）。
         */
        setProjectDelete({ projectId, preview: value.preview });
        setRootNotice(value.preview);
        return;
      }
      if (value.status === 'denied') {
        setProjectDelete(undefined);
        setRootNotice(`不能删除：${value.message}${value.hint !== undefined ? `（${value.hint}）` : ''}`);
        return;
      }
      setProjectDelete(undefined);
      setRootNotice(
        `已删除项目（${value.removedNodes} 个节点一并清除）` +
          (value.reboundProjectId !== undefined
            ? '；本工作区已重建为一个空项目，可以直接重新建树'
            : ''),
      );
      refresh();
    });
  }, [board?.projectId, deleting, projectDelete, refresh, sessionId]);

  /** 确认删除（弹窗里那个按钮）：走服务端 `confirm: true`。 */
  const confirmDeleteProject = useCallback(() => {
    doDeleteProject();
  }, [doDeleteProject]);

  /**
   * **取消删除**（用户口径："没有取消操作"）—— 0.3.24 新增。
   *
   * 语义就是"我改主意了"：只撤掉待确认状态。
   *
   * ⚠️ **不要顺手清 `rootNotice`**（0.3.27 独立审查指出）：那行还承载着
   * "整理为单一根"之类的**上一次操作结果**，取消删除不该把它一起抹掉 —— 那是信息丢失。
   */
  const cancelDeleteProject = useCallback(() => {
    setProjectDelete(undefined);
  }, []);

  /**
   * **切换项目时作废"待确认的删除"**（0.3.27 独立审查指出的"可跨工作区确认"缺陷）。
   *
   * ## 缺陷现场
   *
   * 弹窗开着（针对项目 A）→ 用户切到工作区 B（面板每秒轮询，`board.projectId` 跟着变）→
   * 点「确认删除」⇒ `doDeleteProject` 取的是**当下**的 `board.projectId`（= B），
   * 而 `projectDelete.projectId` 是 A ⇒ `pending` 判为 undefined ⇒ 发出 `{projectId: B}` **不带 confirm**
   * ⇒ 服务端只回 preview（**不删**，这条防线救了一命）⇒ 弹窗内容变成 B ⇒ **再点一次才真删 B**。
   *
   * 也就是说：它不会误删，但会**把确认框悄悄换成另一个项目**，用户以为在删 A、其实在删 B。
   * 修法：项目一变就作废待确认状态，弹窗自己关掉。
   */
  const projectIdForDeleteGuard = board?.projectId;
  useEffect(() => {
    setProjectDelete(undefined);
  }, [projectIdForDeleteGuard]);

  /**
   * 回滚浮层（FR-51b/53b）：**选回滚点 + 选范围**，所以不能复用"是/否"确认框。
   *
   * 两阶段：先以 `confirm:false` 拿影响范围与快照清单，用户在浮层里选好后
   * 再以 `confirm:true` 执行。确认人是面板前的当场用户（§6.7f 第 2 行）。
   */
  const [rollbackPrompt, setRollbackPrompt] = useState<
    | {
        nodeId: string;
        branch: boolean;
        preview: string;
        snapshots: SnapshotRow[];
        snapshotId: string;
        scope: 'code' | 'state' | 'both';
        confirmShared: boolean;
        sharedBlocked?: string[];
      }
    | undefined
  >(undefined);

  /** 第一步：拿影响范围 + 回滚点清单（不执行任何回滚）。 */
  const askRollback = useCallback(
    (nodeId: string, branch: boolean) => {
      setMenuError(undefined);
      setMenuNotice(undefined);
      void Promise.all([
        postRollback({
          nodeId,
          branch,
          scope: 'both',
          confirm: false,
          ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
        }),
        fetchSnapshots(nodeId, undefined, sessionId),
      ]).then(([outcome, list]) => {
        if (!outcome.ok || !outcome.value) {
          setMenuError(outcome.error ?? '未知错误');
          return;
        }
        const value = outcome.value;
        if (value.status !== 'needs-confirm') {
          setMenuError(
            value.status === 'denied'
              ? (value.message ?? value.reason ?? '被拒绝')
              : '仍在待确认状态：请重新点击。',
          );
          return;
        }
        const snapshots = list.ok && list.value ? list.value.snapshots : [];
        const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1]!.snapshotId : '';
        setRollbackPrompt({
          nodeId,
          branch,
          preview: value.preview,
          snapshots,
          snapshotId: latest,
          scope: 'both',
          confirmShared: false,
        });
      });
    },
    [sessionId],
  );

  /** 第二步：用户选好回滚点与范围后执行。 */
  const confirmRollback = useCallback(() => {
    const pending = rollbackPrompt;
    if (!pending) return;
    void postRollback({
      nodeId: pending.nodeId,
      branch: pending.branch,
      scope: pending.scope,
      confirm: true,
      confirmShared: pending.confirmShared,
      ...(pending.snapshotId !== '' ? { snapshotId: pending.snapshotId } : {}),
      ...(sessionId !== undefined && sessionId !== '' ? { sessionId } : {}),
    }).then((outcome) => {
      if (!outcome.ok || !outcome.value) {
        setMenuError(outcome.error ?? '未知错误');
        return;
      }
      const value = outcome.value;
      if (value.status === 'denied') {
        // 共享文件被拦：把清单带回浮层，勾选"同时还原"再来一次（而不是让用户猜）
        if (value.code === 'C_SHARED') {
          const blocked = (value.hint ?? '')
            .split('：')
            .slice(1)
            .join('：')
            .split('、')
            .map((item) => item.trim())
            .filter((item) => item !== '');
          setRollbackPrompt({ ...pending, sharedBlocked: blocked });
          setMenuError(value.message ?? '需要二次确认共享文件');
          return;
        }
        setMenuError(value.message ?? value.reason ?? '被拒绝');
        return;
      }
      if (value.status !== 'ok') {
        setMenuError('仍在待确认状态：请重新点击。');
        return;
      }
      setRollbackPrompt(undefined);
      setMenuNotice(
        `回滚完成：还原 ${value.restoredFiles.length} 个文件、删除 ${value.deletedFiles.length} 个、重置 ${value.resetNodes} 个节点` +
          (value.preRollbackSnapshotId !== undefined ? '（已建 pre-rollback，可撤销）' : ''),
      );
      refresh();
    });
  }, [refresh, rollbackPrompt, sessionId]);

  /**
   * 统一的"节点旁浮层"：文本输入（添加/改名/描述）与确认（暂停/拦停/回滚点/删除整枝）。
   *
   * 三者合成一个 `overlay` 交给画布渲染 —— 浮层贴在**被操作的节点旁边**，
   * 而不是渲染在面板顶部让用户去找（实测反馈："跳到了标题那里，我还要找它"）。
   */
  const overlay: FlowOverlay | undefined = menuText
    ? { kind: 'text', nodeId: menuText.nodeId, title: menuText.label }
    : menuConfirm
      ? {
          kind: 'confirm',
          nodeId: menuConfirm.nodeId,
          title: `确认${menuConfirm.label}？`,
          body: menuConfirm.preview,
        }
      : removePrompt
        ? {
            kind: 'confirm',
            nodeId: removePrompt.nodeId,
            title: '确认删除整枝？',
            body: removePrompt.preview,
          }
        : rollbackPrompt
          ? {
              kind: 'rollback',
              nodeId: rollbackPrompt.nodeId,
              title: rollbackPrompt.branch ? '确认整枝回滚？' : '确认回滚？',
              branch: rollbackPrompt.branch,
              preview: rollbackPrompt.preview,
              snapshots: rollbackPrompt.snapshots,
              snapshotId: rollbackPrompt.snapshotId,
              scope: rollbackPrompt.scope,
              confirmShared: rollbackPrompt.confirmShared,
              ...(rollbackPrompt.sharedBlocked !== undefined
                ? { sharedBlocked: rollbackPrompt.sharedBlocked }
                : {}),
            }
          : undefined;

  /** 浮层提交：按当前挂起的是哪一种操作分发。 */
  const submitOverlay = useCallback(
    (text: string) => {
      if (menuText !== undefined) {
        const pending = menuText;
        setMenuText(undefined);
        runNodeAction(pending.action, pending.nodeId, { text });
        return;
      }
      if (menuConfirm !== undefined) {
        const pending = menuConfirm;
        setMenuConfirm(undefined);
        runNodeAction(pending.action, pending.nodeId, { confirm: true });
        return;
      }
      if (removePrompt !== undefined) {
        confirmRemove();
        return;
      }
      if (rollbackPrompt !== undefined) confirmRollback();
    },
    [confirmRemove, confirmRollback, menuConfirm, menuText, removePrompt, rollbackPrompt, runNodeAction],
  );

  const cancelOverlay = useCallback(() => {
    setMenuText(undefined);
    setMenuConfirm(undefined);
    setRemovePrompt(undefined);
    setRollbackPrompt(undefined);
  }, []);

  /** 菜单入口：按动作类型分流。 */
  const handleNodeAction = useCallback(
    (action: PanelNodeAction | 'remove' | 'rollback' | 'branch-rollback', nodeId: string) => {
      // 删除走的是「三方案 + 影响范围确认」那条独立路径
      if (action === 'remove') {
        setMenuNotice(undefined);
        askRemove(nodeId);
        return;
      }
      // 回滚/整枝回滚走「选回滚点 + 选范围」那条独立路径（FR-51b/53b）
      if (action === 'rollback' || action === 'branch-rollback') {
        askRollback(nodeId, action === 'branch-rollback');
        return;
      }
      const textLabels: Partial<Record<PanelNodeAction, string>> = {
        'add-child': '新子节点名称',
        rename: '新名称',
        describe: '节点描述',
      };
      const textLabel = textLabels[action];
      if (textLabel !== undefined) {
        setMenuNotice(undefined);
        setMenuInput('');
        setMenuText({ action, nodeId, label: textLabel });
        return;
      }
      runNodeAction(action, nodeId);
    },
    [askRemove, askRollback, runNodeAction],
  );

  /** ③ 状态条内容：冲突 / 降级 / 文档 / 外部改动 + 图例与口径。 */
  const status = useMemo(() => {
    if (!board) return null;
    return React.createElement(
      'div',
      { style: { padding: '8px 16px 16px' } },
      board.externalChange
        ? React.createElement(
            'div',
            { style: { ...styles.warn, marginBottom: 8 } },
            `外部改动：${board.externalChange.path}（${
              board.externalChange.kind === 'document-changed'
                ? board.externalChange.documentLegal === false
                  ? '文档已不合法'
                  : '文档仍合法'
                : board.externalChange.kind === 'handoff-changed'
                  ? '交接文档变动'
                  : '事实源区域变动'
            }）`,
            React.createElement(
              'div',
              { style: styles.note },
              '文档只是投影：外部改动不会被读成权威值，节点一律以事实源为准。' +
                '需要收敛时用 pm_doc_check（write=true）重新投影。',
            ),
          )
        : null,
      board.conflicts.length > 0
        ? React.createElement(
            'div',
            { style: { ...styles.error, marginBottom: 8 } },
            `⚠ ${board.conflicts.length} 个待仲裁冲突：`,
            board.conflicts.map((c) => ` ${c.code}@${c.nodeId || '?'}`).join('、'),
          )
        : null,
      board.degradation.length > 0
        ? React.createElement(
            'div',
            { style: { ...styles.warn, marginBottom: 8 } },
            '降级项：',
            React.createElement(
              'ul',
              { style: { margin: '4px 0 0 16px', padding: 0 } },
              board.degradation.map((item, index) =>
                React.createElement('li', { key: index }, item),
              ),
            ),
          )
        : null,
      !board.document.legal
        ? React.createElement(
            'div',
            { style: { ...styles.warn, marginBottom: 8 } },
            `文档 ${board.document.path} ${board.document.exists ? '不合法' : '尚未生成'}：`,
            board.document.violations.length > 0
              ? React.createElement(
                  'ul',
                  { style: { margin: '4px 0 0 16px', padding: 0 } },
                  board.document.violations.slice(0, 6).map((v, index) =>
                    React.createElement('li', { key: index }, v),
                  ),
                )
              : null,
          )
        : null,
      React.createElement('div', { style: styles.sectionTitle }, '图例与口径'),
      React.createElement(
        'div',
        { style: styles.note },
        `整体口径：${formatBasis(board.overall)}；快照档位：${board.snapshot.mode}（${board.snapshot.reason}）`,
        React.createElement('br'),
        board.overall.structuralDegenerate === true
          ? React.createElement(
              'span',
              null,
              '⚠ 结构上没有任何区分度（零 token 路径没拿到文件数/行数差异）→ ' +
                '本页数字等同于按件数，已按「按件数·无结构数据」标注。',
              React.createElement('br'),
            )
          : null,
        '流程图编码：边框=完成态、填充/角标=状态、节点数字=总任务点/已完成（叶给百分比）、连线=聚焦关系；',
        '符号含义、数字口径与操作入口都在标题栏的「图例」里（图例与画法同源，不会对不上号）。',
        React.createElement('br'),
        `确认通道：${board.confirmChannel}`,
        React.createElement('br'),
        '本看板只给百分比与未完成计数，不提供"还需多久"的周期估算。',
      ),
    );
  }, [board]);

  /**
   * 未完成列表（FR-35/36）：**弹窗**，不再是画布上方的内联展开块。
   *
   * 用户实测反馈（原话"改为modal形式"）：内联展开会把**中间那段（流程图）**挤下去，
   * 而看板中间必须是图、不是清单。弹窗化之后：画布高度不再随列表开合变化，
   * 列表本身还能给更多行、更大宽度，Esc / 点背景即可关闭（与回滚浮层、右键菜单同一套习惯）。
   */
  const list = useMemo(
    () =>
      React.createElement(UnfinishedListModal, {
        nodes: board?.unfinished ?? [],
        ...(selectedId !== undefined ? { selectedId } : {}),
        onPick: (nodeId: string) => {
          setSelectedId(nodeId);
          setShowList(false);
        },
        onClose: () => setShowList(false),
      }),
    [board, selectedId],
  );


  return React.createElement(
    'div',
    { style: styles.root },
    // ── ① 标题看板（FR-30–34：只有百分比与计数，绝不出现周期） ──────────
    React.createElement(
      'div',
      { style: styles.board },
      React.createElement(
        'div',
        { style: styles.titleRow },
        React.createElement('span', { style: styles.projectName }, board?.projectName ?? '项目进度'),
        React.createElement(
          'label',
          { style: styles.toggleLabel, title: '只看未完成：把已完成节点从图中滤掉（FR-48）' },
          React.createElement('input', {
            type: 'checkbox',
            checked: hideDone,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setHideDone(event.target.checked),
          }),
          '只看未完成',
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setShowList((prev) => !prev),
            style: styles.headerButton,
            title:
              '打开未完成清单（弹窗；Esc 或点背景关闭）。清单不再占用画布高度 —— 看板中间必须是图，不是清单',
          },
          `未完成 ${board?.unfinished.length ?? 0} 项 ${showList ? '▾' : '⧉'}`,
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: () => setShowLegend(true),            style: styles.headerButton,
            title: '打开流程图图例：完成态、状态角标、数字口径、连线强弱、画布上的操作入口',
          },
          '图例',
        ),
        React.createElement(
          'button',
          { type: 'button', onClick: refresh, style: styles.headerButton },
          '刷新',
        ),
        /*
          「整理为单一根」（用户反馈："顶级节点按理就只有一个"）。
          只在**真的多于一个**顶级节点时出现 —— 这是数据异常的自救入口，不是常驻按钮。
          只改父子关系、不删任何节点（服务端逐枝判定，结果如实回报）。
        */
        liveRootCount > 1
          ? React.createElement(
              'button',
              {
                type: 'button',
                style: { ...styles.headerButton, borderColor: '#f59e0b' },
                title: `发现 ${liveRootCount} 个顶级节点（应为 1）：把多余的整枝并入任务点最多的那个；只改父子关系，不删节点`,
                onClick: () => {
                  void postMergeRoots()
                    .then((outcome) => {
                      const value = outcome.value;
                      if (outcome.ok && value?.status === 'ok' && value.canonical !== undefined) {
                        const mergedCount = value.merged?.length ?? 0;
                        const failed = value.failures ?? [];
                        setRootNotice(
                          `已把 ${mergedCount} 枝并入「${value.canonical.name}」` +
                            (failed.length > 0 ? `；${failed.length} 枝未并入（${failed[0]?.reason}）` : ''),
                        );
                      } else {
                        setRootNotice(`未整理：${outcome.error ?? value?.message ?? '未知原因'}`);
                      }
                      refresh();
                    })
                    .catch((error: unknown) =>
                      setRootNotice(`整理失败：${error instanceof Error ? error.message : String(error)}`),
                    );
                },
              },
              `整理为单一根（${liveRootCount}）`,
            )
          : null,
        /**
         * 「根节点归位」——**只归位、不重建**（0.3.36）。
         *
         * 为什么需要它：AI 建树反复把"项目本体"建成某个端的子节点（真机三次重建、
         * 三次不同的错法），而归位原本只在建树流程里跑 ⇒ 已经建好的树要修一层层级
         * 就得整个重建（几万 token）。这条按钮让那件事变成一次**不花钱**的结构操作。
         *
         * 判据在服务端（纯函数，只看"同一个东西被建成了两个节点"）；
         * 这里只负责触发与如实回报"动没动、为什么"。
         */
        liveRootCount === 1
          ? React.createElement(
              'button',
              {
                type: 'button',
                style: styles.headerButton,
                'data-pm-normalize-root': '1',
                title:
                  '检查根节点是不是「某个端」。' +
                  '⚠️ 若判定需要归位，现行领域模型下**改不动**（提根会造第二个根、降级旧根会成环），它会如实说明原因 —— 这种情况只能重建。不调模型、不花钱。',
                onClick: () => {
                  void postNormalizeRoot()
                    .then((outcome) => {
                      const value = outcome.value;
                      if (outcome.ok && value !== undefined) {
                        setRootNotice(
                          value.moved > 0
                            ? `根节点已归位（搬动 ${value.moved} 个节点）：${value.reason}`
                            : `根节点无需归位：${value.reason}`,
                        );
                      } else {
                        setRootNotice(`归位失败：${outcome.error ?? '未知原因'}`);
                      }
                      refresh();
                    })
                    .catch((error: unknown) =>
                      setRootNotice(`归位失败：${error instanceof Error ? error.message : String(error)}`),
                    );
                },
              },
              '根节点归位',
              )
            : null,
          /**
           * 「树体检」——**只读**（0.3.48）。
           *
           * 用户问过两次"这棵树是否健康"，而我两次都是临时写脚本才算出来。
           * 这个按钮把结论放到用户手边：一条不带"通过"的体检结论，比十条没人看的日志有用。
           * 判据全在服务端纯函数里，这里只负责触发与逐条展示。
           */
          liveRootCount > 0
            ? React.createElement(
                'button',
                {
                  type: 'button',
                  style: styles.headerButton,
                  'data-pm-tree-health': '1',
                  title: '检查这棵树健康不健康：根是否是项目本体、哪一层摊平了、有没有单子链/' +
                    '名字就是目录名的节点/同一批路径被建了两遍/refs 指向不存在的路径。只读，不改树。',
                  onClick: () => {
                    void fetchTreeHealth()
                      .then((outcome) => {
                        const report = outcome.value?.report;
                        if (!outcome.ok || report === undefined) {
                          setRootNotice(`树体检失败：${outcome.error ?? '未知原因'}`);
                          return;
                        }
                        const parts: string[] = [
                          `树体检：${report.stats.alive} 节点 / 根 ${report.stats.roots} 个 / ` +
                            `根下 ${report.stats.rootChildren} 支 / 最深 ${report.stats.maxDepth} 层`,
                        ];
                        for (const issue of report.issues) {
                          const mark = issue.severity === 'error' ? '⛔' : issue.severity === 'warn' ? '⚠️' : 'ℹ️';
                          parts.push(`${mark} ${issue.message}`);
                        }
                        if (report.issues.length === 0) parts.push('没有发现问题 ✓');
                        setRootNotice(parts.join('\n'));
                      })
                      .catch((error: unknown) =>
                        setRootNotice(`树体检失败：${error instanceof Error ? error.message : String(error)}`),
                      );
                  },
                },
                '树体检',
            )
          : null,
        /*
          「删除此项目」——清理入口（真机现场：试错留下的整棵树 / 幽灵空项目没有别的清理方式，
          只能在树里一枝一枝删，而用户想扔的是**整个项目**）。
          两段式：第一下只显示影响范围，**再点一下同一个**才真删；当前绑定项目会被服务端拒。
        */
        liveRootCount > 0
          ? React.createElement(
              'button',
              {
                type: 'button',
                style: {
                  ...styles.headerButton,
                  borderColor: projectDelete !== undefined ? '#ef4444' : undefined,
                  color: projectDelete !== undefined ? '#ef4444' : undefined,
                },
                title:
                  projectDelete !== undefined
                    ? '再点一次即**彻底删除这个项目**（连同审计/冲突/快照，不可撤销）'
                    : '删除这个项目（把整棵树连同记录一起清掉；当前绑定的项目不允许删）',
                onClick: doDeleteProject,
              },
              projectDelete !== undefined ? '等待确认…' : '删除此项目',
            )
          : null,
      ),
      // 删除项目的结果 / 影响范围（与「整理为单一根」共用同一处显示位，不弹窗）
      rootNotice !== undefined
        ? React.createElement('div', { style: { ...styles.note, marginTop: 2 } }, rootNotice)
        : null,
      /**
       * "根从哪来"必须可见（FR-71 口径同源）：用户最容易被"面板锁错工作区"迷惑。
       *
       * 0.3.2 起这一行从**纯文本变成控件**：面板自己声明作用域（`root` 查询参数），
       * 所以用户既能看出"现在是哪个工作区、为什么是它"，也能**就在这里切** ——
       * 不必离开看板去左侧栏点一遍、回来还得指望面板认对。
       *
       * **只有一个动作**：下拉里选 = 只切这个看板的作用域（看进度不必跳转）。
       * 「在侧边栏打开」已在 0.3.8 去掉 —— 它的语义其实是"连接该工作区并打开
       * 复用或新建的空白会话"，点下去常常只是**新建一个空会话**，与按钮字面承诺不符
       * （用户原话："点一下只是新建会话，价值不大"）。
       */
      React.createElement(WorkspaceSwitcher, {
        pick: props.workspacePick,
        options: props.workspaceOptions ?? [],
        boardRoot: board?.workspaceRoot.value ?? null,
        onScope: (option: WorkspaceOption) => props.onSelectWorkspace?.(option),
      }),
      // 宿主回报的解析来源：与上面那个控件互补 —— 控件说"我要哪个"，
      // 这一行说"宿主最后给了哪个、按什么判据"（两者不一致时就是排查线索）
      React.createElement(
        'div',
        { style: { ...styles.note, marginTop: 2 }, title: sessionId ? `会话 ${sessionId}` : '未拿到当前会话' },
        board?.workspaceRoot.value
          ? `宿主解析：${board.workspaceRoot.value}（来源：${board.workspaceRoot.source}）`
          : '宿主未解析到工作区（面板不会读任何目录）',
      ),
      // 版本与规模自检：面板"空白"时，这一行能不能看到就是最快的分诊信息
      // （能看到 → 面板在渲染，问题在中间画布；看不到 → 主槽位压根没渲染我们的组件）
      React.createElement(
        'div',
        { style: { ...styles.note, opacity: 0.55 } },
        // 规模行只说规模与口径。面板版本号是装饰性信息（对使用者没有决策价值），已移除 —— FR-154 第 4 条；
        // 排查版本错位去 /pm/debug 看。
        `${board ? `${board.nodes.length} 个节点` : '正在读取…'} · ` +
          // FR-158 ③：疑似遗留是"该决定去留"的信号，必须在看板层面看得见 ——
          // 只藏在单节点上，用户翻不到就等于没标记。它**照常计入统计**（所以这里只报个数，不改分母口径）。
          `${
            board && staleCount > 0
              ? `${staleCount} 个疑似遗留待清理 · `
              : ''
          }` +
          `口径 ${formatBasis(board?.overall)}`,
      ),
      error
        ? React.createElement(
            'div',
            { style: styles.error },
            `数据通道不可用：${error}（宿主 HTTP 路由 /pm 未注册时会出现这种情况）`,
          )
        : null,
      React.createElement(
        'div',
        // `data-pm-metrics`：指标行的锚点。自检据此**只在这一行内**核对"同一个数字串不出现两次"
        // （画布节点自己也会写 `总/已完成`，那是它的本分，不是同屏重复）。
        { style: styles.metrics, 'data-pm-metrics': '1' },
        // 指标行：**每格只给一个数字串，且同一个数不在行内出现两次**（用户："繁琐不" + "又是重复"）。
        // 「整体完成度 40%」与「任务点 3/1」**是同一个数**（`已完成/总` 与 `1-已完成/总`）→ 已删该格，
        // 整体进度由「任务点」这一格承担（它同时是主口径 `总/已完成`）。
        // 「关注枝」**必须保留**（FR-31 要求看板显示关注枝完成度），且它**只给百分比**：
        // 若给它再挂 `d/n`，它与整体那格就不是同一个数了，不构成重复——但它服务的是**另一条枝的局部比例**，
        // 没有第二格承接，所以按 A1 的"完成到哪了"给百分比即足。
        metric('任务点', board ? formatCounts(board.overall) : '—', '总 / 已完成'),
        metric('关注枝', board === undefined || board.focusedRootIds.length === 0 ? '—' : formatPercent(board.focused), ''),
        metric('进行中', board ? String(board.overall.runningNodes) : '—', ''),
        metric('异常', board ? String(board.overall.errorNodes) : '—', ''),
        metric('未完成', board ? String(board.overall.unfinishedLeaves) : '—', ''),
      ),
      board && board.scanBand.length > 0
        ? React.createElement(
            'div',
            {
              style: styles.band,
              // 这条带画的是**全部**任务点（已完成的那根会淡化），所以名字照实叫"任务点扫描带"，
              // 不叫"未完成扫描带"——口径要和画出来的东西一致（用户纠偏：以进度为主）
              title: '任务点扫描带：每根竖条 = 一个任务点（叶节点），颜色 = 其计算状态，已完成淡化；点击定位',
            },
            board.scanBand.map((cell) =>
              React.createElement('span', {
                key: cell.nodeId,
                style: {
                  ...styles.bandCell,
                  background: DERIVED_STATE_COLOR[cell.derivedState] ?? '#999',
                  opacity: cell.derivedState === 'done' ? 0.35 : 1,
                  outline: cell.isFocus ? '1px solid currentColor' : 'none',
                },
                title: `${cell.name} · ${DERIVED_STATE_LABEL[cell.derivedState] ?? cell.derivedState}`,
                onClick: () => selectNode(cell.nodeId),
              }),
            ),
          )
        : null,
      showList ? list : null,
      showLegend ? React.createElement(CanvasLegendModal, { onClose: () => setShowLegend(false) }) : null,
      // AI 建树入口（FR-39 默认路径）。**先给成本再花 token**：
      // 第一次点击只拿预估（不调模型），确认框里写明发多少内容/几次调用/约多少 token。
      React.createElement(
        'div',
        { style: styles.aiBar },
        React.createElement(
          'button',
          {
            type: 'button',
            style: styles.headerButton,
            onClick: askAiBuild,
            disabled: aiBusy,
            title: '让模型读目录骨架与关键文件签名，生成功能点/任务点，并同批给出相对工作量与完成度初判',
          },
          // 0.3.21：不再先估成本（用户口径："不再做 token 预算，直接 AI 生成树"）
          aiBusy ? '正在生成树…' : '用 AI 建树（直接生成）',
        ),
        React.createElement(
          'span',
          { style: { ...styles.note, marginLeft: 8 } },
          '只发送目录骨架与关键文件签名；建树、相对工作量、完成度初判在同一次调用里完成。',
        ),
      ),
      /**
       * **「删除此项目」的确认弹窗**（0.3.24，用户口径："删除此项目 没有取消操作，
       * 弹出一个 modal 确认框怎么了，办不到吗"）。
       *
       * 原先是**两段式内联**：点一下显示影响范围、**再点同一个按钮**才真删。两个问题：
       * ① **没有取消操作** —— 想反悔只能再点一下，而那正是"确认删除"；
       * ② 影响范围只是页面上多一行小字，一个删掉整棵树的动作不该这么轻。
       *
         * 现在走弹窗：影响范围写在框里，**「确认删除」与「取消」并列**，点遮罩也算取消。
         * 服务层不动（它本来就是 `needs-confirm` → `confirm: true` 两段式，AI 工具那条路还在用）。
         *
         * ⚠️ **执行中要锁**（0.3.37，用户反馈："点击后没有锁页面，好像在删除过程中能点其他地方"）：
         * 删除请求发出去之后 —— 按钮禁用并改文案、遮罩点了也不关、重复点击直接忽略。
         * 理由：那一刻关掉弹窗只会让人以为"取消了"，而请求**已经发出去了**；
         * 不可逆操作最怕的就是"以为没生效，于是又点了一次"。
         */
        projectDelete !== undefined
          ? React.createElement(
              'div',
              {
                style: {
                  ...styles.modalBackdrop,
                  /** 执行中给一个"忙"的光标反馈（视觉上也说明这一下点不动）。 */
                  ...(deleting ? { cursor: 'progress' as const } : {}),
                },
                role: 'presentation',
                'data-pm-delete-modal': '1',
                'data-pm-delete-busy': deleting ? '1' : '0',
                /** 点遮罩：不忙时算取消；执行中不关（关掉会误导成"取消了"）。 */
                onMouseDown: (event: React.MouseEvent) => {
                  if (event.target !== event.currentTarget) return;
                  if (deleting) return;
                  cancelDeleteProject();
                },
              },
              React.createElement(
                'div',
                {
                  style: styles.modalCard,
                  role: 'dialog',
                  'aria-modal': true,
                  'aria-label': '确认删除这个项目',
                  onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
                },
                React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '确认删除这个项目？'),
                React.createElement('div', { style: styles.note }, projectDelete.preview),
                deleting
                  ? React.createElement(
                      'div',
                      { style: { ...styles.note, marginTop: 6 }, 'data-pm-delete-progress': '1' },
                      '正在删除…删除期间请勿操作（这一步不可撤销）。',
                    )
                  : null,
                React.createElement(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 10 } },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      style: {
                        ...styles.headerButton,
                        ...(deleting ? { opacity: 0.5, cursor: 'not-allowed' as const } : {}),
                      },
                      'data-pm-delete-confirm': '1',
                      disabled: deleting,
                      onClick: confirmDeleteProject,
                    },
                    deleting ? '删除中…' : '确认删除',
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      style: {
                        ...styles.headerButton,
                        ...(deleting ? { opacity: 0.5, cursor: 'not-allowed' as const } : {}),
                      },
                      'data-pm-delete-cancel': '1',
                      /** 执行中不给取消：请求已经发出去了，"取消"给不了任何保证。 */
                      disabled: deleting,
                      onClick: cancelDeleteProject,
                    },
                    '取消',
                  ),
                ),
              ),
            )
          : null,
      // **AI 建树的确认框（红框）与结果（白框）都以模态框呈现**（用户口径："红框部分，和生成的
      // 内容展示部分（白框），用 modal 吧，执行中不可点击空白取消，只能明确点取消或关闭"）。
      // 原来内联在标题区：① 内容一长就把画布挤下去；② 点空白会连带触发画布"取消选中"，
      // 让人以为弹窗被关掉了 —— 而模型调用其实还在跑。
      aiPrompt !== undefined || aiResult !== undefined || aiError !== undefined
        ? React.createElement(
            'div',
            {
              style: styles.modalBackdrop,
              role: 'presentation',
              'data-pm-ai-modal': '1',
              /**
               * 点遮罩的处置：**执行中一律不关**（`modal-dismiss.ts` 里那条规则的唯一落点）。
               * 执行中关掉没有好处 —— 调用还在跑、token 还在烧，却看不到进度与结果；
               * 要停就点明确的「取消并中止这次调用」。
               *
               * **必须判 `event.target === event.currentTarget`**：遮罩是卡片的父元素，
               * 事件会冒泡上来 —— 少了这一判，点卡片里的随便哪里（比如那两个勾选框）
               * 都会被当成"点了空白"，弹窗直接消失、根本没法勾选（实测就是这个现象）。
               * 判据与画布"点空白才算点空白"完全同一套：**看真实按压目标**。
               */
              onMouseDown: (event: React.MouseEvent) => {
                if (event.target !== event.currentTarget) return;
                if (dismissibleByBackdrop(aiBusy)) closeAiModal();
              },
            },
            React.createElement(
              'div',
              {
                style: styles.modalCard,
                role: 'dialog',
                'aria-modal': true,
                // 双保险：卡片内部的事件不往遮罩传（未来若改成 onClick 也不会踩同一个坑）
                onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
              },
              React.createElement(
                'div',
                { style: { fontWeight: 600, marginBottom: 4 } },
                // 缓存命中时标题就该改口：这不是"花 token"，而是"零 token 复用"。
                // 旧宿主不给 cache（undefined）→ 按"要花钱"的措辞，宁可保守也不能骗人。
                aiPrompt?.cache?.state === 'hit' || aiPrompt?.cache?.state === 'resume'
                  ? '可以直接复用上次结果（不花钱）'
                  : aiPrompt !== undefined
                    ? '确认花费 token 建树？'
                    : 'AI 建树结果',
              ),
            aiPrompt !== undefined ? React.createElement('div', { style: styles.note }, aiPrompt.description) : null,
            aiPrompt !== undefined
              ? React.createElement(
                  'div',
                  { style: { ...styles.note, marginTop: 2 } },
                  `模型路由：${aiPrompt.route}`,
                )
              : null,
            // T6/T9：把"这次到底花不花钱"摆在确认按钮旁边（含改动了哪些文件）
            aiPrompt !== undefined
              ? React.createElement(
                  'div',
                  {
                    style: {
                      ...styles.note,
                      marginTop: 4,
                      ...(aiPrompt.cache?.state === 'hit' || aiPrompt.cache?.state === 'resume'
                        ? { color: '#22c55e' }
                        : {}),
                    },
                  },
                  aiPrompt.cache === undefined
                    ? '宿主未返回缓存状态（可能是旧版本）：按"会调用模型"对待。'
                    : aiPrompt.cache.state === 'hit'
                      ? `缓存命中：输入与上次逐字节相同，本次不调用模型（省约 ${aiPrompt.cache.savedTokens ?? 0} token）。`
                      : aiPrompt.cache.state === 'resume'
                        ? `可续跑：复用上次被中断时已拿到的结果，本次不调用模型（省约 ${aiPrompt.cache.savedTokens ?? 0} token）。`
                        : cacheChangeLine(aiPrompt.cache),
                )
              : null,
            true
              ? React.createElement(
                  'label',
                  {
                    style: { ...styles.note, display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 },
                  },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: aiReplaceDraft,
                    // **执行中禁用**（用户实测反馈："生成中 checkbox 可操作"）：
                    // 勾选项只影响"发出去的那一次请求"，跑到一半再改它没有任何作用，
                    // 却让人以为改动生效了 —— 禁用比"改了没用"诚实。
                    disabled: aiBusy,
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                      setAiReplaceDraft(event.target.checked),
                  }),
                  '先清掉上次自动生成的草稿（想**从零重来**才勾：草稿先删 ⇒ 本轮无法复用既有节点 ⇒ ' +
                    '节点数会涨，实测 99 → 129；只清没人动过的，仅删记录）',
                )
              : null,
            // T6 的逃生口：增量按"大小 + 修改时间"判定，同一时间刻度内的同尺寸改动可能漏检，
            // 所以永远给用户一个"我就是要重算"的开关（勾了必然花钱，写清楚）
            true
              ? React.createElement(
                  'label',
                  {
                    style: { ...styles.note, display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 },
                  },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: aiForceRebuild,
                    disabled: aiBusy, // 同上：跑起来之后再改这个勾没有意义
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                      setAiForceRebuild(event.target.checked),
                  }),
                  '忽略缓存，强制重新调用模型（会花钱；只在怀疑缓存过时时勾）',
                )
              : null,
            /**
             * **运行中的实时进度**（FR-167）——token 数是**粗估**、字符数是事实、上限是确定值；
             * 有提供方用量时改说"本次实际消耗"。
             *
             * **完成后继续保留**（用户口径："生成后，进度条保留，保持 100%，并能看到 token 消耗"）：
             * 所以这里**不再要求 `aiBusy`**，只要宿主给了快照就显示；完成时进度条按 100% 画。
             */
            board?.aiRun != null
              ? React.createElement(
                  'div',
                  { style: { ...styles.note, marginTop: 8 }, 'data-pm-ai-run': '1' },
                  React.createElement(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                    React.createElement('span', undefined, aiRunText(board.aiRun)),
                    React.createElement(
                      'span',
                      undefined,
                      `${board.aiRun.phase === 'done' ? 100 : aiRunPercent(board.aiRun)}%`,
                    ),
                  ),
                  React.createElement(
                    'div',
                    { style: styles.aiRunTrack },
                    React.createElement('div', {
                      style: {
                        ...styles.aiRunFill,
                        width: `${board.aiRun.phase === 'done' ? 100 : aiRunPercent(board.aiRun)}%`,
                        // 只有**真的被截断**才用红（红在本项目专供"删除/异常"）
                        ...(board.aiRun.truncated ? { background: '#ef4444' } : {}),
                      },
                    }),
                  ),
                )
              : null,
            // 结果（白框）：模态框里给**固定高度 + 滚动**（用户实测："生成后的文字溢出 modal，没有滚动"）
            aiResult !== undefined
              ? React.createElement(
                  'div',
                  {
                    style: { ...styles.note, marginTop: 8, whiteSpace: 'pre-line' as const, ...styles.modalScroll },
                    'data-pm-ai-result': '1',
                  },
                  aiResult,
                )
              : null,
            aiError !== undefined
              ? React.createElement(
                  'div',
                  { style: { ...styles.error, marginTop: 8 }, 'data-pm-ai-error': '1' },
                  aiError,
                )
              : null,
            React.createElement(
              'div',
              { style: { display: 'flex', gap: 8, marginTop: 8 } },
              /**
               * 0.3.21：**点一次就直接建树**，所以"跑起来之后"不该再摆一个"确认并开始建树"按钮 ——
               * 那会让人以为还需要再点一次。只在**旧宿主回了 `needs-confirm`**（它是两段式的）
               * 且**当前不在跑**时，才给出那个确认按钮，让新旧宿主都能用。
               */
              aiResult !== undefined
                ? // 已有结果：这一个按钮就够了（点空白关不掉，只能显式关）
                  React.createElement(
                    'button',
                    { type: 'button', style: styles.headerButton, onClick: closeAiModal },
                    '关闭',
                  )
                : [
                    /**
                     * 只有"旧宿主两段式、且不在跑"时才显示这个确认按钮（新宿主点一次就建完了）。
                     */
                    !aiBusy && aiPrompt !== undefined
                      ? React.createElement(
                          'button',
                          {
                            key: 'confirm',
                            type: 'button',
                            style: styles.headerButton,
                            onClick: confirmAiBuild,
                          },
                          '确认并开始建树',
                        )
                      : null,
                    // 执行中：**只有这个显式按钮能停**（点空白不会关，见上面 backdrop 的 onMouseDown）
                    aiBusy
                      ? React.createElement(
                          'button',
                          {
                            key: 'cancel-run',
                            type: 'button',
                            style: styles.headerButton,
                            onClick: cancelAiBuild,
                            'data-pm-ai-cancel': '1',
                          },
                          '取消并中止这次调用',
                        )
                      : React.createElement(
                          'button',
                          { key: 'cancel', type: 'button', style: styles.headerButton, onClick: closeAiModal },
                          '关闭',
                        ),
                  ],
            ),
            ),  // 卡片（模态正文）闭合
          )
        : null,
      // FR-167：运行中的实时进度已挪进模态框（见 AiBuildModal），标题区不再内联显示。

      // **AI 建树的确认框 / 进度 / 结果都改到模态框里**（用户口径："红框部分，和生成的内容
      // 展示部分（白框），用 modal 吧，执行中不可点击空白取消，只能明确点取消或关闭"）。
      // 原来内联在标题区有两个问题：① 内容一长就把画布挤下去；② 点空白处会连带触发
      // 画布的"取消选中"，用户会以为弹窗被关掉了。见下方 `AiBuildModal`。
      // **这里曾有「已选：x / 删除整枝… / 取消选择」一整条操作条，已整条删掉**（用户口径：
      // "红框标记的删除整枝 去掉，右键有这个功能，功能性重复"）。整条都是重复：
      // ① 「删除整枝」= 右键菜单第 12 项（`menuItems`）的同名同路径入口；
      // ② 「已选：x」= 画布的选中高亮 + 右栏属性栏标题，说了第三遍；
      // ③ 「取消选择」= 点画布空白处 / 右栏关闭按钮，本就不是"必须按按钮才能做"的事。
      // 节点删除在界面上**只留右键一处**（面板属性栏也不放删除，避免第二个重复面）。
      // 注意：删除确认框与文本输入框都**不在**标题区渲染，而是通过 `overlay`
      // 交给画布贴在节点旁边（见下方 FlowCanvas 的 props）。这里只留错误提示。
      removeError
        ? React.createElement('div', { style: { ...styles.error, marginTop: 6 } }, removeError)
        : null,
    ),
    // ── ② 流程图（FR-40/FR-46a；中间这一段必须是图，不是列表） ──────────
    error && !board
      ? React.createElement(
          'div',
          { style: styles.empty },
          '无法读取看板数据。',
          React.createElement('br'),
          React.createElement('span', { style: styles.note }, '宿主 HTTP 路由 /pm 未注册时会出现这种情况。'),
        )
      : !board
        ? React.createElement(
            'div',
            { style: styles.empty },
            '正在读取看板数据…',
            React.createElement('br'),
            React.createElement('span', { style: styles.note }, '首次加载需要宿主完成能力探测与项目初始化。'),
          )
        : empty
          ? React.createElement(
              'div',
              { style: styles.emptyWrap },
              React.createElement(EmptyState, {
                onApplied: refresh,
                ...(sessionId ? { sessionId } : {}),
              }),
              board.workspaceRoot.value === null
                ? React.createElement(
                    'div',
                    { style: { ...styles.error, marginTop: 8 } },
                    '没有解析到工作区根：看板读不到也不该读任何工作区数据。',
                    React.createElement(
                      'div',
                      { style: styles.note },
                      `来源=${board.workspaceRoot.source}；${board.workspaceRoot.detail}`,
                    ),
                  )
                : null,
            )
          : React.createElement(
              // 中段 = 画布 + 右侧属性栏（选中节点时出现）。
              // 属性栏放在**画布外面**（而不是浮在画布上）：画布量到自己的宽度变窄会重新适配视图，
              // 于是"选中节点"不会把树挡在属性栏底下（实测评过：浮层压住节点最难用）。
              'div',
              { style: styles.middle },
              React.createElement(
                'div',
                { style: styles.canvasSlot },
                React.createElement(
                  CanvasBoundary,
                  {
                    onError: (error: Error) =>
                      reportClient({
                        panelId: 'project-manager',
                        bundleId: 'dsh-project-progress',
                        registeredSlots: [],
                        error: { kind: 'canvas-render', message: error.message, ...(error.stack !== undefined ? { stack: error.stack } : {}) },
                      }),
                  },
                  React.createElement(FlowCanvas, {
                    nodes: board.nodes,
                    selectedId,
                    onSelect: selectNode,
                    hideDone,
                    /**
                     * **逐节点**判"在跑"，两个信号都来自宿主（同源）：
                     * - `activeNodeIds`：这一轮真的被忙碌会话动过的节点（**首选**，事实）；
                     * - `busySessionIds`：哪些会话在忙（兜底判据要用它）。
                     *
                     * 早先传的是一个布尔 `sessionBusy = 本会话在忙`，等于"**整棵树**在跑" ——
                     * 用户实测："全在转，但是没有会话在跑吧""线路全部都有了动画，而不是正在跑的"。
                     */
                    /**
                     * ⚠️ **不要在这里自己拆字段**：`undefined`（旧宿主，走窗口兜底）与 `[]`
                     * （宿主报了"这轮没动过节点"）语义相反，随手 `?? []` 会让**旧宿主永远不转圈**。
                     * 统一走 `livenessArgsOf`（有测试钉住这个区分）。
                     */
                    ...livenessArgsOf(board),
                    /**
                     * **拖拽改父**（用户诉求："移到…/拖拽改父"）：落点确定后调 `set-parent`。
                     *
                     * 服务端内核是 `reparentSubtree`（成环保护 + 审计），客户端只负责"谁挂到谁下面"。
                     * 失败要**如实报出来** —— 静默不动会让人以为"拖了没反应"。
                     */
                    onReparent: (nodeId: string, newParentId: string) => {
                      void postNodeAction({ action: 'set-parent', nodeId, text: newParentId }).then((outcome) => {
                        if (outcome.ok && outcome.value?.status === 'ok') {
                          const parentName = String(outcome.value.detail?.['parentName'] ?? '');
                          setMenuNotice(`已把节点挂到「${parentName}」下`);
                          refresh();
                          return;
                        }
                        setMenuNotice(outcome.value?.message ?? outcome.error ?? '改父节点失败');
                      });
                    },
                    // 折叠状态的本地持久化作用域（换项目就是另一棵树）
                    projectId: board.projectId,
                    onAction: handleNodeAction,
                    // 菜单**同步**决定「回滚」显不显示（FR：没有回滚点就不显示）
                    rollbackPoints: (nodeId: string) => board.rollbackPoints?.[nodeId] ?? 0,
                    /* AI 发起、等待审核的待删除节点 → 画布描边变红（FR-159） */
                    pendingRemovals: board.pendingRemovals ?? [],
                    // 输入/确认浮层贴在被操作的节点旁边（而不是标题区）
                    overlay,
                    overlayText: menuInput,
                    onOverlayTextChange: setMenuInput,
                    onSubmit: submitOverlay,
                    onCancel: cancelOverlay,
                    onRollbackChoice: (choice: RollbackChoice) =>
                      setRollbackPrompt((prev) =>
                        prev === undefined
                          ? prev
                          : {
                              ...prev,
                              snapshotId: choice.snapshotId,
                              scope: choice.scope,
                              confirmShared: choice.confirmShared,
                            },
                      ),
                  }),
                ),
              ),
              React.createElement(NodeInspector, {
                node: selectedNode,
                /**
                 * 属性栏的动作分发：`set-priority` 需要**带文本**（1–10，空串=清除），
                 * 所以这一条单独走 `postNodeAction`；其余动作仍交给统一的 `handleNodeAction`
                 * （它们的文本走画布上的浮层输入，不从这里传）。
                 */
                onAction: (action: PanelNodeAction | 'rollback' | 'branch-rollback', nodeId: string, text?: string) => {
                  if (action !== 'set-priority') {
                    handleNodeAction(action, nodeId);
                    return;
                  }
                  void postNodeAction({ action: 'set-priority', nodeId, text: text ?? '' }).then((outcome) => {
                    if (outcome.ok && outcome.value?.status === 'ok') {
                      setMenuNotice(
                        text === undefined || String(text).trim() === ''
                          ? '已清除优先级'
                          : `优先级已设为 ${String(text).trim()}（来源：人；AI 建树不会覆盖它）`,
                      );
                      refresh();
                      return;
                    }
                    setMenuNotice(outcome.value?.message ?? outcome.error ?? '设置优先级失败');
                  });
                },
                onClose: () => setSelectedId(undefined),
                rollbackPoints:
                  selectedNode === undefined ? 0 : (board.rollbackPoints?.[selectedNode.id] ?? 0),
                /**
                 * 会话导航能力：**从模块级注册表读**（不靠 props 传，见 `setSessionNavigation` 的说明）。
                 * 宿主没提供时不传 ⇒ 属性栏那一行退化成纯文本。
                 */
                ...(getSessionNavigation() !== undefined
                  ? {
                      onOpenSession: (id: string) => getSessionNavigation()?.openSession(id),
                      onStartSession: () => getSessionNavigation()?.startSession(),
                    }
                  : {}),
                // 点引用要在**当前会话**的右栏打开文件（地址带会话作用域）
                sessionId,
              }),
            ),
    // ── ③ 状态条（可折叠）：冲突 / 降级 / 文档 / 外部改动 / 口径图例 ─────
    React.createElement(
      'div',
      { style: styles.statusBar },
      React.createElement(
        'div',
        { style: styles.statusRow },
        React.createElement(
          'button',
          { type: 'button', onClick: () => setShowStatus((prev) => !prev), style: styles.statusToggle },
          `状态与口径 ${showStatus ? '▾' : '▸'}`,
          board && board.conflicts.length > 0
            ? React.createElement('span', { style: styles.statusBadge }, `${board.conflicts.length} 冲突`)
            : null,
          board && board.degradation.length > 0
            ? React.createElement('span', { style: styles.statusBadge }, `${board.degradation.length} 降级`)
            : null,
          board && !board.document.legal
            ? React.createElement('span', { style: styles.statusBadge }, '文档未生成')
            : null,
        ),
        // FR-174：宿主出错/告警时，状态条右侧给一个**可点**的角标（点开诊断页看原文）。
        // 折叠状态下也照样显示 —— 警示的价值就在于"不用展开也能看见"。
        alertChip === undefined
          ? null
          : React.createElement(
              'a',
              {
                href: debugUrl(),
                target: '_blank',
                rel: 'noreferrer',
                title: alertChip.title,
                style: {
                  ...styles.alertChip,
                  ...(alertChip.tone === 'error' ? styles.alertChipError : styles.alertChipWarn),
                },
                // 渲染自检靠它定位这个角标（不依赖文案，文案会改）
                'data-pm-alert-chip': alertChip.tone,
              },
              alertChip.label,
              alertChip.tone === 'error' && alertChip.ackAt !== undefined
                ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      title: '知悉（先把这条红标收起来，日志仍在 /pm/debug）',
                      style: styles.alertAck,
                      // 角标是链接、里面套了个按钮：不拦住的话点"知悉"会顺着链接跳走
                      onClick: (event: React.MouseEvent) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setAlertsAckedAt(alertChip.ackAt);
                      },
                    },
                    '×',
                  )
                : null,
            ),
      ),
      showStatus
        ? React.createElement('div', { style: styles.statusBody }, status)
        : null,
    ),
  );
}

/**
 * 运行中的建树进度：**百分比**（FR-167）。
 *
 * 上限缺失/非法时返回 0 —— 宁可不画，也不画一条除零出来的假进度。
 */
export function aiRunPercent(run: { outputTokensEstimate: number; outputLimit: number }): number {
  if (!Number.isFinite(run.outputLimit) || run.outputLimit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((run.outputTokensEstimate / run.outputLimit) * 100)));
}

/**
 * 运行中的建树进度：**一句人话**。
 *
 * 口径三分（与宿主 `ai/progress.ts` 同一套说法）：字符数是**事实**、token 是**粗估**、
 * 上限是**确定值**；有提供方真实用量时改口说"本次实际消耗"（**实测**，与粗估分开说）。
 * 完成后这一行**继续保留**（用户口径："生成后，进度条保留，保持 100%"）。
 */
export function aiRunText(run: NonNullable<BoardSnapshot['aiRun']>): string {
  const shard = run.shardTotal > 1 ? `第 ${run.shardIndex}/${run.shardTotal} 片，` : '';
  const limitText =
    run.outputLimit > 0 ? (run.truncated ? `已到输出上限 ${run.outputLimit}，被截断。` : `上限 ${run.outputLimit}。`) : '上限：跟随宿主的模型设置。';
  const body =
    run.actual !== undefined
      ? `本次实际消耗：输出 ${run.actual.outputTokens ?? '—'} / 输入 ${run.actual.inputTokens ?? '—'} token（提供方回报）／`
      : `已生成约 ${run.outputTokensEstimate} token（粗估 ${run.outputChars} 字符）／`;
  const phase = run.phase === 'done' ? '已完成。' : run.phase === 'error' ? '这一轮没成功。' : '';
  return `${shard}${body}${limitText}${phase}`;
}

/** 增量一行话：文件新增/删除/变化各多少，并把前几个路径点出来。 */
function cacheChangeLine(cache: AiCacheView): string {
  const changed = cache.changed;
  if (changed === undefined) return '缓存未命中：本次会真的调用模型（首次建树，或换了模型/输出上限）。';
  const parts = [
    changed.added.length > 0 ? `新增 ${changed.added.length}` : '',
    changed.removed.length > 0 ? `删除 ${changed.removed.length}` : '',
    changed.changed.length > 0 ? `变化 ${changed.changed.length}` : '',
  ].filter((part) => part !== '');
  const sample = [...changed.changed, ...changed.added].slice(0, 3).join('、');
  return parts.length === 0
    ? '缓存未命中：本次会真的调用模型。'
    : `增量：${parts.join(' · ')}${sample === '' ? '' : `（如 ${sample}）`} —— 本次会真的调用模型。`;
}

function metric(label: string, value: string, sub: string): React.ReactElement {
  return React.createElement(
    'div',
    { style: styles.metric },
    React.createElement('span', { style: styles.metricLabel }, label),
    React.createElement('span', { style: styles.metricValue }, value),
    sub ? React.createElement('span', { style: styles.metricLabel }, sub) : null,
  );
}

/**
 * 空工作区引导（FR-38：检测到无项目树时给一句可执行的下一步，而不是显示空白页）。
 *
 * **这里原先有两个按钮：「扫描工作区」+「建树」** —— 它们把**目录**直接当功能点建进树里
 * （用户实测投诉："这是什么插件，你按项目进度走的…现在项目进度是什么，就是功能模块的开发情况，
 * 不是目录的情况"）。那条产品路径已整体删除：目录骨架不再产出任何节点。
 *
 * 现在只留一句话：树要靠 **AI 建树**（面板上方那个按钮，先看成本再花 token）或手工新增节点。
 */
function EmptyState(_props: { onApplied: () => void; sessionId?: string }): React.ReactElement {
  return React.createElement(
    'div',
    { style: { ...styles.warn, marginBottom: 12 } },
    React.createElement('div', { style: { fontWeight: 600, marginBottom: 4 } }, '这个工作区还没有项目树'),
    React.createElement(
      'div',
      { style: styles.note },
      '用上方的「用 AI 建树（直接生成）」生成功能/任务点树 —— 它按代码的功能语义分，不按目录分。',
    ),
    React.createElement(
      'div',
      { style: { ...styles.note, marginTop: 6 } },
      '也可以直接在树上手工新增节点（右键 / 面板操作）。目录不会成为节点，只作为建树的输入。',
    ),
  );
}
