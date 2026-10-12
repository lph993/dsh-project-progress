/**
 * `client/workspace-select.ts` 的测试 —— 0.3.2 修"看板看错工作区"的核心判据。
 *
 * 真机症状（用户原话）："项目进度看板(菜单)，工作区切换不方便，现有的还时灵时不灵"。
 * 根因是**面板从来没声明自己在看哪个工作区**：
 *
 * ```
 * GET /pm/board                   → bound     → E:\WxObj\COP（最后一个动过树的）77 节点
 * GET /pm/board?sessionId=<本会话> → tool-call → E:\thirty\dsh-project-progress  未命名项目
 * ```
 *
 * 修法是让路径说话（判据链见模块头注释）。这个文件把四级判据**逐条钉死**，
 * 并守住两条纪律：判据顺序不许换（换了就会退化成"猜最近用过的那个"）、
 * 排序必须稳定（否则下拉会在轮询刷新时自己跳位置）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activeSessionFromList,
  candidateSessionIds,
  describeWorkspacePickSource,
  pickWorkspace,
  pickWorkspaceSession,
  toWorkspaceOptions,
  type SessionLookup,
  type WorkspaceOptionLike,
} from '../../src/client/workspace-select.ts';

/** 造一行 `WorkspaceView`（只写用到的字段）。 */
const row = (
  workspaceId: string,
  path: string,
  updatedAt: string,
  sessionIds: string[] = [],
  title?: string,
): WorkspaceOptionLike => ({
  workspaceId,
  path,
  updatedAt,
  sessionIds,
  ...(title !== undefined ? { title } : {}),
});

describe('toWorkspaceOptions：只留能用的行，且顺序稳定', () => {
  it('没有路径的行一律丢掉（没有路径就无从请求看板）', () => {
    const options = toWorkspaceOptions([
      row('a', 'E:\\a', '2026-01-01T00:00:00Z'),
      { workspaceId: 'b', title: '没有路径' },
      { workspaceId: 'c', path: '   ' },
    ]);
    assert.deepEqual(options.map((o) => o.path), ['e:/a']);
  });

  it('路径按比较口径归一（反斜杠、盘符大小写、结尾斜杠）', () => {
    const [option] = toWorkspaceOptions([row('a', 'E:\\WxObj\\COP\\', '2026-01-01T00:00:00Z')]);
    assert.equal(option?.path, 'e:/WxObj/COP', '大写盘符 + 反斜杠 + 结尾斜杠都要归一');
  });

  it('按 updatedAt 倒序；同刻按标题兜底 ⇒ 每次刷新顺序一致（下拉不许自己跳位置）', () => {
    const options = toWorkspaceOptions([
      row('a', 'E:/a', '2026-01-01T00:00:00Z', [], '甲'),
      row('b', 'E:/b', '2026-03-01T00:00:00Z', [], '乙'),
      row('c', 'E:/c', '2026-01-01T00:00:00Z', [], '丙'),
    ]);
    assert.deepEqual(options.map((o) => o.title), ['乙', '丙', '甲']);
  });

  it('标题缺失时用路径末段；workspaceId 缺失时用路径当 key（保证 key 稳定）', () => {
    const [option] = toWorkspaceOptions([{ path: 'E:/x/末段', updatedAt: '2026-01-01T00:00:00Z' }]);
    assert.equal(option?.title, '末段');
    assert.equal(option?.key, 'e:/x/末段');
  });

  it('sessionIds 里的非字符串会被剔掉（脏数据不该让选中判据崩掉）', () => {
    const [option] = toWorkspaceOptions([
      { path: 'E:/a', updatedAt: '2026-01-01T00:00:00Z', sessionIds: ['s1', 42, null, ''] },
    ]);
    assert.deepEqual(option?.sessionIds, ['s1']);
  });
});

describe('pickWorkspace：四级判据，顺序不许换', () => {
  const options = toWorkspaceOptions([
    row('a', 'E:/alpha', '2026-03-01T00:00:00Z', ['s-alpha'], '甲'),
    row('b', 'E:/beta', '2026-01-01T00:00:00Z', ['s-beta'], '乙'),
  ]);

  it('① 手动选择 > 一切（用户刚选的必须一直压着自动判据）', () => {
    const picked = pickWorkspace({ options, currentSessionId: 's-beta', manualPath: 'E:/alpha' });
    assert.equal(picked?.option.path, 'e:/alpha');
    assert.equal(picked?.source, 'manual');
  });

  it('② 拿不到会话归属时退回"最近变更"，不是"随便挑一个"', () => {
    const picked = pickWorkspace({ options });
    assert.equal(picked?.option.path, 'e:/alpha', 'updatedAt 最新的那个');
    assert.equal(picked?.source, 'recent');
  });

  it('③ 会话所属 > 最近变更：**这条是"跟着你走"的关键**', () => {
    const picked = pickWorkspace({ options, currentSessionId: 's-beta' });
    assert.equal(picked?.option.path, 'e:/beta', '会话在乙 ⇒ 就看乙，哪怕甲更新');
    assert.equal(picked?.source, 'session');
  });

  it('④ 会话不属于任何工作区 ⇒ 退回最近变更（不猜、不报错）', () => {
    const picked = pickWorkspace({ options, currentSessionId: '某个孤立的会话' });
    assert.equal(picked?.option.path, 'e:/alpha');
    assert.equal(picked?.source, 'recent');
  });

  it('⑤ 手动路径已失效（那个工作区被删了）⇒ 落到下一级判据，而不是空着', () => {
    const picked = pickWorkspace({ options, currentSessionId: 's-beta', manualPath: 'E:/早就没了' });
    assert.equal(picked?.option.path, 'e:/beta');
    assert.equal(picked?.source, 'session');
  });

  it('只有一个工作区时判据记为 first（列表首个 = 唯一那个）', () => {
    const single = toWorkspaceOptions([row('a', 'E:/only', '2026-03-01T00:00:00Z')]);
    const picked = pickWorkspace({ options: single });
    assert.equal(picked?.source, 'first');
    assert.equal(picked?.option.path, 'e:/only');
  });

  it('一个可选工作区都没有 ⇒ undefined（调用方据此不画控件）', () => {
    assert.equal(pickWorkspace({ options: [] }), undefined);
  });

  it('判据名字要能显示给人看（四种都有说法，不能出现空白标签）', () => {
    for (const source of ['manual', 'session', 'recent', 'first'] as const) {
      assert.notEqual(describeWorkspacePickSource(source).trim(), '');
    }
  });
});

/**
 * 「我正在看哪个会话」的判据（0.3.4 重写）。
 *
 * ⚠️ 这组测试的另一半价值是**反面**：它取代的旧实现（`useSessionRetainInfo` 键控 Hook）
 * 会在 `useMemo` 里按会话数可变次数调用 Hook，真机抛 `Minified React error #311`、
 * 把 `main` 槽位打崩、**整个看板打不开**（0.3.3 的事故）。
 * 现有实现只依赖**非键控**的会话列表（`cwd` + `updatedAt`），没有 Hook 次数问题。
 */
describe('会话所属：按 cwd / updatedAt 找"我在那个工作区待着的会话"', () => {
  /** 造一个会话列表访问面。 */
  const lookup = (
    rows: Array<{ id: string; cwd?: string; updatedAt?: number; origin?: string }>,
  ): SessionLookup => {
    const byId = new Map(rows.map((r) => [r.id, { sessionId: r.id, cwd: r.cwd, updatedAt: r.updatedAt, origin: r.origin }]));
    return { ids: rows.map((r) => r.id), summaryOf: (id) => byId.get(id) };
  };

  it('按 cwd 归一化匹配（盘符大小写 / 斜杠方向不同也算同一个工作区）', () => {
    const option = toWorkspaceOptions([row('a', 'E:\\WxObj\\COP', '2026-01-01T00:00:00Z')])[0]!;
    const found = pickWorkspaceSession(option, ['s1'], lookup([{ id: 's1', cwd: 'e:/WxObj/COP', updatedAt: 5 }]).summaryOf);
    assert.equal(found, 's1');
  });

  it('同一工作区里取 updatedAt 最大的（最近活跃的那个）', () => {
    const option = toWorkspaceOptions([row('a', 'E:/alpha', '2026-01-01T00:00:00Z')])[0]!;
    const sessions = lookup([
      { id: 'old', cwd: 'E:/alpha', updatedAt: 100 },
      { id: 'new', cwd: 'E:/alpha', updatedAt: 900 },
      { id: 'other', cwd: 'E:/beta', updatedAt: 9999 },
    ]);
    assert.equal(pickWorkspaceSession(option, sessions.ids, sessions.summaryOf), 'new');
  });

  it('**排除子代理会话**：它们是工作线程，不是"用户在看的那个会话"', () => {
    const option = toWorkspaceOptions([row('a', 'E:/alpha', '2026-01-01T00:00:00Z')])[0]!;
    const sessions = lookup([
      { id: 'sub', cwd: 'E:/alpha', updatedAt: 9999, origin: 'subagent' },
      { id: 'mine', cwd: 'E:/alpha', updatedAt: 100 },
    ]);
    assert.equal(pickWorkspaceSession(option, sessions.ids, sessions.summaryOf), 'mine');
  });

  it('cwd 缺失时兜底用工作区自己的会话记账（目录被移走也不至于判丢）', () => {
    const option = toWorkspaceOptions([row('a', 'E:/alpha', '2026-01-01T00:00:00Z', ['s1'])])[0]!;
    const sessions = lookup([{ id: 's1', updatedAt: 7 }]);
    assert.equal(pickWorkspaceSession(option, sessions.ids, sessions.summaryOf), 's1');
  });

  it('都不属于 ⇒ undefined（调用方退到 recent 判据，绝不瞎猜）', () => {
    const option = toWorkspaceOptions([row('a', 'E:/alpha', '2026-01-01T00:00:00Z')])[0]!;
    const sessions = lookup([{ id: 'x', cwd: 'E:/beta', updatedAt: 1 }]);
    assert.equal(pickWorkspaceSession(option, sessions.ids, sessions.summaryOf), undefined);
  });

  it('跨工作区：列表里先命中哪个工作区就用哪个（顺序即工作区的 updatedAt 倒序）', () => {
    const options = toWorkspaceOptions([
      row('a', 'E:/alpha', '2026-03-01T00:00:00Z'),
      row('b', 'E:/beta', '2026-01-01T00:00:00Z'),
    ]);
    const sessions = lookup([{ id: 'in-beta', cwd: 'E:/beta', updatedAt: 50 }]);
    assert.equal(activeSessionFromList(options, sessions), 'in-beta', 'alpha 没有会话 ⇒ 落到 beta');
  });

  it('会话面缺失 ⇒ undefined（不抛、不猜）', () => {
    assert.equal(activeSessionFromList(toWorkspaceOptions([row('a', 'E:/a', 'x', ['s'])]), undefined), undefined);
  });

  it('candidateSessionIds：跨工作区去重、顺序稳定（顺序由工作区 updatedAt 倒序决定）', () => {
    const options = toWorkspaceOptions([
      row('a', 'E:/a', '2026-01-01T00:00:00Z', ['s1', 's2']),
      row('b', 'E:/b', '2026-06-01T00:00:00Z', ['s2', 's3']),
    ]);
    // b 的 updatedAt 更新 ⇒ 排在前；s2 只出现一次（去重）
    assert.deepEqual(
      options.map((o) => o.path),
      ['e:/b', 'e:/a'],
      '前置条件：工作区按 updatedAt 倒序',
    );
    assert.deepEqual(candidateSessionIds(options), ['s2', 's3', 's1']);
  });
});
