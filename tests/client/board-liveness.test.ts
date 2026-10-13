/**
 * **看板字段 → 活跃判据入参** 的翻译测试（0.3.11）。
 *
 * ## 为什么单独测这一层
 *
 * 判据本身有 13 条测试，但它们喂的是**正确的输入**；而我真机踩到的坑在**调用方**：
 * 顺手写 `board.activeNodeIds ?? []` 会把两个语义相反的取值压成同一个 ——
 *
 * ```
 * undefined → 宿主不报该字段（旧宿主）⇒ 走"会话在忙 + 时间窗"兜底
 * []        → 宿主报了"这轮没动过任何节点" ⇒ 一律不转
 * ```
 *
 * 压平之后，**旧宿主上永远不转圈**（用户报的"该转的没转"原样保留）。
 * 这个错纯函数测试抓不到，只有把"翻译"这一步单独拎出来测才挡得住。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { livenessArgsOf, liveNodeIdsOf } from '../../src/client/board-liveness.ts';
import { isLiveNode } from '../../src/client/liveness.ts';

/** 造一个节点（只带判据需要的字段）。 */
function node(id: string, lastSessionId: string | undefined, updatedAt: string | undefined) {
  return { id, name: id, lastSessionId, updatedAt };
}

/** 宿主格式的 UTC 时间戳。 */
function hostStamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

describe('livenessArgsOf：两个字段的默认值不能混为一谈', () => {
  it('缺失 `activeNodeIds` ⇒ 保留 `undefined`（**不能**变成空数组）', () => {
    const args = livenessArgsOf({ busySessionIds: ['s1'] });
    assert.equal(
      args.activeNodeIds,
      undefined,
      'undefined 表示"这个宿主不支持该字段" ⇒ 必须走窗口兜底；压成 [] 会让旧宿主永远不转圈',
    );
    assert.deepEqual(args.busySessionIds, ['s1']);
  });

  it('宿主报了空数组 ⇒ 保留空数组（语义是"这轮没动过任何节点"）', () => {
    const args = livenessArgsOf({ busySessionIds: ['s1'], activeNodeIds: [] });
    assert.deepEqual(args.activeNodeIds, [], '空数组必须原样保留 ⇒ 一律不转');
  });

  it('`busySessionIds` 缺失可以安全地当空（"没人忙"与"字段缺失"后果一致）', () => {
    assert.deepEqual(livenessArgsOf({ activeNodeIds: ['n1'] }).busySessionIds, []);
    assert.deepEqual(livenessArgsOf(undefined).busySessionIds, []);
    assert.equal(livenessArgsOf(undefined).activeNodeIds, undefined);
  });
});

describe('liveNodeIdsOf：同一份数据，旧宿主与新宿主的结论必须不同', () => {
  const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);
  const fresh = hostStamp(NOW - 30_000); // 30 秒前被写过（窗口内）
  const nodes = [node('n1', 's1', fresh), node('n2', 's1', fresh)];

  it('旧宿主（没有该字段）⇒ 兜底生效，会转圈的节点非空', () => {
    // 用固定 now 包一层，让测试可复现
    const judge = (_n: unknown, busy: readonly string[], active: readonly string[] | undefined) =>
      isLiveNode(_n as never, busy, active, NOW);
    const ids = liveNodeIdsOf(nodes as never, { busySessionIds: ['s1'] }, judge as never);
    assert.deepEqual(
      [...ids].sort(),
      ['n1', 'n2'],
      '旧宿主走"会话在忙 + 时间窗"兜底 —— **这里为空就说明默认值又被压平了**',
    );
  });

  it('新宿主报了清单 ⇒ 只信清单', () => {
    const judge = (_n: unknown, busy: readonly string[], active: readonly string[] | undefined) =>
      isLiveNode(_n as never, busy, active, NOW);
    const ids = liveNodeIdsOf(
      nodes as never,
      { busySessionIds: ['s1'], activeNodeIds: ['n2'] },
      judge as never,
    );
    assert.deepEqual([...ids], ['n2'], '清单里只有 n2 ⇒ 只有它转圈（n1 时间戳再新也不转）');

    const none = liveNodeIdsOf(
      nodes as never,
      { busySessionIds: ['s1'], activeNodeIds: [] },
      judge as never,
    );
    assert.deepEqual([...none], [], '宿主明确报了"没动过任何节点" ⇒ 一个都不转');
  });
});
