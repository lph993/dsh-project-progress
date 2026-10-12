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
    assert.equal(isLiveNode({ lastSessionId: 's1', updatedAt: fresh }, ['s1'], NOW), true);
    assert.equal(
      isLiveNode({ lastSessionId: 's1', updatedAt: fresh }, ['s2', 's1'], NOW),
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
      isLiveNode({ lastSessionId: 'stale-session', updatedAt: fresh }, ['current-session'], NOW),
      false,
    );
    assert.equal(isLiveNode({ lastSessionId: undefined, updatedAt: fresh }, ['c'], NOW), false);
    assert.equal(isLiveNode({ lastSessionId: '', updatedAt: fresh }, ['c'], NOW), false);
    assert.equal(isLiveNode({ updatedAt: fresh }, ['c'], NOW), false);
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
      isLiveNode({ lastSessionId: 'busy-but-old', updatedAt: stale }, ['busy-but-old'], NOW),
      false,
      '忙会话的历史节点不该转圈',
    );
    assert.equal(
      isLiveNode({ lastSessionId: 's1' }, ['s1'], NOW),
      false,
      '**没有时间戳 ⇒ 不转**（宁可不转，也不编）',
    );
  });

  it('新鲜度的边界：窗口内转、窗口外不转', () => {
    const inWindow = hostStamp(NOW - LIVE_FRESH_WINDOW_MS);
    const outWindow = hostStamp(NOW - LIVE_FRESH_WINDOW_MS - 1000);
    assert.equal(isLiveNode({ lastSessionId: 's1', updatedAt: inWindow }, ['s1'], NOW), true);
    assert.equal(isLiveNode({ lastSessionId: 's1', updatedAt: outWindow }, ['s1'], NOW), false);
  });

  it('没有任何会话在忙 ⇒ 一律不转圈', () => {
    assert.equal(isLiveNode({ lastSessionId: 's1', updatedAt: fresh }, [], NOW), false);
    assert.equal(isLiveNode({ updatedAt: fresh }, [], NOW), false);
  });

  it('边界的对称性：同一个节点，忙的会话列表一变结论就跟着变', () => {
    const node = { lastSessionId: 's1', updatedAt: fresh };
    assert.equal(isLiveNode(node, [], NOW), false);
    assert.equal(isLiveNode(node, ['s1'], NOW), true);
    assert.equal(isLiveNode(node, [], NOW), false, '会话停下 ⇒ 立刻回到 ▶（不许残留转圈）');
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
