/**
 * **工作区切换控件**（0.3.2 新增；0.3.8 去掉"在侧边栏打开"）。
 *
 * ## 为什么要有它
 *
 * 用户原话："项目进度看板(菜单)，工作区切换不方便，现有的还时灵时不灵"。
 * 两件事要分开治：
 *
 * 1. **"时灵时不灵"** —— 面板以前不声明自己在看哪个工作区，宿主只好用"最后绑过的那个"
 *    （诊断原文 `source: 'bound'`）。修法在 `client/workspace-select.ts`：**路径说话**。
 * 2. **"切换不方便"** —— 以前要切工作区，只能离开看板去左侧栏的工作区列表点一遍，
 *    回来还得指望面板认对。现在面板自己带一个下拉：选中即把**面板的作用域**切过去
 *    （立刻拉那个工作区的看板），**看进度不必跳转**。
 *
 * ## 为什么没有"在侧边栏打开"（0.3.8 删掉）
 *
 * 用户原话："项目进度里的打开侧边栏可以去掉，点一下只是新建会话，价值不大。"
 * 实测确实如此：`uiWorkspace.openWorkspace(id)` 的语义是"**连接该工作区并打开它的会话**
 * —— 复用或新建一个空白会话"（官方注释：Resolve the reusable or newly created blank Session）。
 * 用户已经在看某个工作区的进度时，点它得到的往往是一个**新的空会话**，而不是"切过去继续干活"，
 * 所以它既不是"看进度"的必需品，也不符合按钮字面承诺。**与其留一个容易误会的入口，不如去掉**：
 * 真要在那个工作区干活，去左侧栏的工作区列表里点它，本来就是那件事的正确入口。
 *
 * ## 两条纪律
 *
 * - **判据如实显示**：当前工作区旁边写清"为什么是它"（`describeWorkspacePickSource`），
 *   否则用户看到错树时无从判断是"面板选错了"还是"那个工作区真的还没建树"；
 * - **不画点了没反应/名不副实的按钮**（同 `node-inspector` 的纪律）。
 */

import React from 'react';

import {
  describeWorkspacePickSource,
  type WorkspaceOption,
  type WorkspacePick,
} from './workspace-select.ts';
import { normalizeRootPath } from '../shared/path.ts';

const { useState } = React;

export interface WorkspaceSwitcherProps {
  /** 当前面板作用域（`undefined` = 还没算出/没有可选工作区）。 */
  pick: WorkspacePick | undefined;
  /** 全部可选工作区（下拉内容）。 */
  options: readonly WorkspaceOption[];
  /** 面板数据实际来自哪个工作区根（宿主回报的真相，可能与 `pick` 不同）。 */
  boardRoot: string | null;
  /** 用户选择把面板切到某个工作区。 */
  onScope: (option: WorkspaceOption) => void;
}

/**
 * 工作区切换条（纯呈现 + 一个下拉开合状态）。
 *
 * 它是**只读投影**：不写任何事实源，只决定 `GET /pm/board` 带哪个 `root`。
 */
export function WorkspaceSwitcher(props: WorkspaceSwitcherProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const { pick, options, boardRoot } = props;

  // 一个可选项都没有：不画（画一个空下拉比不画更让人困惑）
  if (options.length === 0) return null;

  const current = pick?.option;
  const label = current?.title ?? boardRoot ?? '选择工作区';
  /**
   * **"面板看的"与"宿主回报的"不一致时要说出来** —— 那是唯一能解释
   * "我明明选了这个工作区、数字却是别人的"的信号（例如宿主把路径归一化后仍指向另一份项目）。
   */
  const mismatch =
    current !== undefined &&
    typeof boardRoot === 'string' &&
    boardRoot !== '' &&
    current.path !== normalizeRootPath(boardRoot);

  return React.createElement(
    'div',
    { style: styles.row },
    React.createElement(
      'button',
      {
        type: 'button',
        style: styles.trigger,
        title: '切换这个看板显示哪个工作区的进度（不改变 DSH 侧边栏的选择）',
        onClick: () => setOpen(!open),
      },
      `工作区：${label}`,
      pick !== undefined
        ? React.createElement('span', { style: styles.why }, `（${describeWorkspacePickSource(pick.source)}）`)
        : null,
      React.createElement('span', { style: styles.caret }, open ? '▲' : '▼'),
    ),
    mismatch
      ? React.createElement(
          'span',
          { style: styles.warn },
          `注意：面板数据的工作区是 ${boardRoot}，与我选的不一致`,
        )
      : null,
    open
      ? React.createElement(
          'div',
          { style: styles.menu },
          ...options.map((option) =>
            React.createElement(
              'button',
              {
                key: option.key,
                type: 'button',
                style:
                  option.path === current?.path
                    ? { ...styles.item, ...styles.itemActive }
                    : styles.item,
                title: `${option.path}${option.updatedAt !== '' ? `（最近变更 ${option.updatedAt}）` : ''}`,
                onClick: () => {
                  setOpen(false);
                  props.onScope(option);
                },
              },
              `${option.path === current?.path ? '✓ ' : ''}${option.title}`,
              React.createElement('span', { style: styles.path }, option.path),
            ),
          ),
        )
      : null,
  );
}

const styles = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap' as const,
    marginTop: 4,
    position: 'relative' as const,
  },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '2px 8px',
    fontSize: 12,
    borderRadius: 4,
    border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  why: { opacity: 0.6 },
  caret: { opacity: 0.5, fontSize: 10 },
  warn: { fontSize: 12, color: '#f59e0b' },
  menu: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    zIndex: 20,
    marginTop: 4,
    minWidth: 280,
    maxHeight: 260,
    overflowY: 'auto' as const,
    padding: 4,
    borderRadius: 6,
    border: '0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
    background: 'var(--dsw-alias-bg-base, #1e1e1e)',
    boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
    textAlign: 'left' as const,
  },
  item: {
    display: 'block',
    width: '100%',
    padding: '5px 8px',
    fontSize: 12,
    textAlign: 'left' as const,
    borderRadius: 4,
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  itemActive: { background: 'rgba(128,128,128,0.16)' },
  path: { display: 'block', opacity: 0.55, fontSize: 11, wordBreak: 'break-all' as const },
};
