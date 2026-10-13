/**
 * "节点有没有人在跑"的判据测试（用户三次口径的最终结论 + 0.3.10 的第二次事故）。
 *
 * 这条判据决定界面撒谎不撒谎：转圈 = "正在干活"，播放三角 = "这会儿没人在跑它"。
 * 判错的两种代价不一样 —— 该静的时候还转圈是**无依据地宣称在跑**（A3 不编造），
 * 该转的时候不转只是保守。所以边界一律往"静止"倒。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LIVE_FRESH_WINDOW_MS,
  isLiveNode,
  parseHostUtcStamp,
} from '../../src/client/liveness.ts';

/** 造一个"刚被写过"的宿主时间戳（UTC，形如 `10/12/2026 08:07:16`）。 */
function hostStamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
const fresh = hostStamp(NOW - 10_000); // 10 秒前
const stale = hostStamp(NOW - 3 * 60 * 60 * 1000); // 3 小时前

describe('节点活跃判据（转圈 vs 播放三角）', () => {
  it('所属会话在忙 **且** 刚被写过 ⇒ 转圈', () => {
    assert.equal(isLiveNode({ lastSessionId: 's1', updatedAt: fresh }, ['s1'], undefined, NOW), true);
    assert.equal(
      isLiveNode({ lastSessionId: 's1', updatedAt: fresh }, ['s2', 's1'], undefined, NOW),
      true,
      '列表里有它就够',
    );
  });

  it('**别的**会话在忙 ⇒ 这个节点不转圈（第一次事故的防复发）', () => {
    /**
     * 用户截图原话："全在转，但是没有会话在跑吧" ——
     * 那 5 个 `running` 节点的 `lastSessionId` 是空的、`updatedAt` 是几小时前，
     * 却因为"某个会话在忙"整片转圈（当时判据是 `if (sessionBusy) return true`）。
     */
    assert.equal(
      isLiveNode({ lastSessionId: 'stale-session', updatedAt: fresh }, ['current-session'], undefined, NOW),
      false,
    );
    assert.equal(isLiveNode({ lastSessionId: undefined, updatedAt: fresh }, ['c'], undefined, NOW), false);
    assert.equal(isLiveNode({ lastSessionId: '', updatedAt: fresh }, ['c'], undefined, NOW), false);
    assert.equal(isLiveNode({ updatedAt: fresh }, ['c'], undefined, NOW), false);
  });

  it('**会话在忙但它写的节点很旧** ⇒ 不转圈（0.3.10 修的第二次事故）', () => {
    /**
     * 真机现场（用户原话："COP 中，项目进度流程图不相关的节点也在 loading"）：
     * `session-ce6788ba…` 被报成"在忙"，而它**历史上写过 63 个节点**
     * （建树 + 填进度，全在今早，>1 小时前）⇒ 那 63 个（含 50 个已完成）整片转圈。
     *
     * `lastSessionId` 回答的是"谁**最近**动过它"，不是"谁**正在**动它" ——
     * 一个会话可以忙一整天，早上写过的节点跟"此刻在跑"毫无关系。
     */
    assert.equal(
      isLiveNode({ lastSessionId: 'busy-but-old', updatedAt: stale }, ['busy-but-old'], undefined, NOW),
      false,
      '忙会话的历史节点不该转圈',
    );
    assert.equal(
      isLiveNode({ lastSessionId: 's1' }, ['s1'], undefined, NOW),
      false,
      '**没有时间戳 ⇒ 不转**（宁可不转，也不编）',
    );
  });

  it('新鲜度的边界：窗口内转、窗口外不转', () => {
    const inWindow = hostStamp(NOW - LIVE_FRESH_WINDOW_MS);
    const outWindow = hostStamp(NOW - LIVE_FRESH_WINDOW_MS - 1000);
    assert.equal(isLiveNode({ lastSessionId: 's1', updatedAt: inWindow }, ['s1'], undefined, NOW), true);
    assert.equal(isLiveNode({ lastSessionId: 's1', updatedAt: outWindow }, ['s1'], undefined, NOW), false);
  });

  it('窗口按"一个工作步"取值（10 分钟）—— 别退回 90 秒那种掐掉真干活的量级', () => {
    /**
     * 两个真机数据点把窗口夹在中间：
     * - 32 小时前的节点（65 个）**不该**转 ⇒ 窗口必须远小于它；
     * - "本回合正在干但还没写节点"**可能**要转 ⇒ 窗口不能小到一个工作步都装不下
     *   （实测 90 秒会得到 0 个转圈）。
     */
    assert.equal(LIVE_FRESH_WINDOW_MS, 10 * 60_000);
    assert.ok(LIVE_FRESH_WINDOW_MS > 90_000, '必须比 90 秒宽：那个值实测会掐掉真在干的');
    assert.ok(LIVE_FRESH_WINDOW_MS < 60 * 60_000, '必须远小于小时级：32 小时旧的那些绝不能再转');
  });

  it('没有任何会话在忙 ⇒ 一律不转圈', () => {
    /**
     * ⚠️ `activeNodeIds` 也要一起喂空 —— **宿主报的这个清单本身就按"会话在忙"过滤过了**
     * （`busySessionAndActiveNodes` 只收集 busy 会话动过的节点）。
     * 喂一个"会话列表说没人忙、节点清单却说在动"的矛盾输入，测的是不存在的状态。
     */
    assert.equal(isLiveNode({ lastSessionId: 's1', updatedAt: fresh }, [], undefined, NOW), false);
    assert.equal(isLiveNode({ updatedAt: fresh }, [], undefined, NOW), false);
  });

  it('边界的对称性：同一个节点，忙的会话列表一变结论就跟着变', () => {
    const node = { lastSessionId: 's1', updatedAt: fresh };
    // 两条路径各测一遍，因为结论来源不同：兜底路径看 busySessionIds，清单路径看 activeNodeIds
    assert.equal(isLiveNode(node, [], undefined, NOW), false);
    assert.equal(isLiveNode(node, ['s1'], undefined, NOW), true);
    assert.equal(isLiveNode(node, [], undefined, NOW), false, '会话停下 ⇒ 立刻回到 ▶（不许残留转圈）');
    // 清单路径：宿主报了清单、但里面没有这个节点 ⇒ 即使时间戳很新也不转
    assert.equal(
      isLiveNode({ ...node, id: 'n-not-active' }, ['s1'], ['n-active'], NOW),
      false,
      '宿主报了清单却没这个节点 ⇒ 不能用时间戳推翻它',
    );
    assert.equal(isLiveNode({ ...node, id: 'n-active' }, ['s1'], ['n-active'], NOW), true);
  });
});

describe('宿主明说"这轮动过它" ⇒ 就转圈（0.3.11：修"该转的没转"）', () => {
  it('`activeNodeIds` 命中即转，**不看时间戳新旧**', () => {
    /**
     * 用户口径："之前的问题是'不该转的转了'，现在的是'该转的没转'。"
     *
     * 为什么会"该转的没转"：`updatedAt` 只在**插件工具写节点**时刷新，而干活的顺序是
     * "读代码、改代码 → **收尾时**才补记节点" ⇒ 干活途中时间戳本来就是旧的。
     * 所以"多少秒算刚动过"这种窗口两头都错过：宽了把 32 小时前的旧节点转起来，
     * 紧了把正在干的掐掉（实测 90 秒时得到 0 个转圈）。
     *
     * 现在宿主在写路径（`patchNode`）收口记账，报的是**事实**：它说在动就一定转。
     */
    const veryOld = hostStamp(NOW - 30 * 60 * 60 * 1000); // 30 小时前写的
    assert.equal(
      isLiveNode({ id: 'n1', lastSessionId: 's1', updatedAt: veryOld }, ['s1'], ['n1'], NOW),
      true,
      '宿主说这轮动过它 ⇒ 即使 updatedAt 很旧也要转',
    );
    assert.equal(
      isLiveNode({ id: 'n1', lastSessionId: 's1', updatedAt: undefined }, ['s1'], ['n1'], NOW),
      true,
      '没有时间戳（从未补记过）也不影响：走的是事实那条路，不是时间窗',
    );
  });

  it('`activeNodeIds` 没命中 ⇒ 走兜底判据（会话在忙 + 窗口内）', () => {
    const fresh = hostStamp(NOW - 10_000);
    assert.equal(
      isLiveNode({ id: 'other', lastSessionId: 's1', updatedAt: fresh }, ['s1'], ['n1'], NOW),
      false,
      '宿主明确报了清单、而这个节点不在里面 ⇒ 不转（**不许**用时间戳推翻宿主的结论）',
    );
    assert.equal(
      isLiveNode({ id: 'n1', lastSessionId: 's1', updatedAt: fresh }, ['s1'], undefined, NOW),
      true,
      '宿主**不报**这个字段（旧宿主）⇒ 兜底判据照常工作（向后兼容）',
    );
    assert.equal(
      isLiveNode({ id: 'other', lastSessionId: 's1', updatedAt: stale }, ['s1'], undefined, NOW),
      false,
      '旧宿主路径下，很旧的节点仍然不转',
    );
  });

  it('两条路径都倾向"不转"：没有 activeNodeIds、会话不忙、时间戳不认识 ⇒ 一律不转', () => {
    assert.equal(isLiveNode({ id: 'n1' }, [], undefined, NOW), false);
    assert.equal(isLiveNode({ id: 'n1', lastSessionId: 's1' }, [], undefined, NOW), false);
    assert.equal(isLiveNode({ id: 'n1', lastSessionId: 's1' }, ['s1'], undefined, NOW), false);
  });
});

describe('parseHostUtcStamp：宿主的时间戳按 UTC 解（别再偏一个时区）', () => {
  it('`MM/DD/YYYY HH:mm:ss` 按 UTC 解，不按本地时间', () => {
    const parsed = parseHostUtcStamp('10/12/2026 08:07:16');
    assert.equal(parsed, Date.UTC(2026, 9, 12, 8, 7, 16));
  });

  it('ISO 串照常可解（带 Z / 带偏移）', () => {
    assert.equal(parseHostUtcStamp('2026-10-12T08:07:16.000Z'), Date.UTC(2026, 9, 12, 8, 7, 16));
  });

  it('认不出来 ⇒ undefined（调用方据此判"不知道 ⇒ 不转"）', () => {
    assert.equal(parseHostUtcStamp(undefined), undefined);
    assert.equal(parseHostUtcStamp(''), undefined);
    assert.equal(parseHostUtcStamp('前天'), undefined);
  });
});
