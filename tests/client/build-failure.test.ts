/**
 * **建树请求失败之后该说什么**（0.3.63）。
 *
 * 真机现场：分批建树的请求挂了 11 分 36 秒，连接被掐断 ⇒ 面板只拿到 `Failed to fetch`，
 * 而服务端**已经把树建好**（77 个节点）。用户看到红字最自然的反应是再点一次 ⇒ 白花一轮钱。
 *
 * 这组用例钉住：**"响应没回来" ≠ "服务端没做完"**。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeBuildFetchFailure } from '../../src/client/build-failure.ts';

describe('建树请求失败后的结论', () => {
  it('看板说 done ⇒ 按**已完成**呈现（这是真机那次的事实）', () => {
    const verdict = describeBuildFetchFailure({
      error: 'Failed to fetch',
      board: { runPhase: 'done', nodeCount: 77 },
    });
    assert.equal(verdict.kind, 'completed');
    assert.match(verdict.message, /已完成/);
    assert.match(verdict.message, /77 个节点/, '把节点数说出来，用户才好判断要不要再建');
    assert.doesNotMatch(verdict.message, /别急着重试/, '已经成功了就别再报警');
  });

  it('看板拿不到 ⇒ 事实不明，必须**劝阻重试**', () => {
    const verdict = describeBuildFetchFailure({ error: 'Failed to fetch' });
    assert.equal(verdict.kind, 'unknown');
    assert.match(verdict.message, /别急着重试/);
  });

  it('看板说还在跑 ⇒ 也不许催用户重试', () => {
    for (const runPhase of ['running', 'error', undefined]) {
      const verdict = describeBuildFetchFailure({ error: 'Failed to fetch', board: { runPhase } });
      assert.equal(verdict.kind, 'unknown', `phase=${String(runPhase)} 不许当成功`);
      assert.match(verdict.message, /别急着重试/);
    }
  });

  it('错误为空串时也要有话说（不许出现"undefined"）', () => {
    const verdict = describeBuildFetchFailure({ error: '   ', board: { runPhase: 'running' } });
    assert.doesNotMatch(verdict.message, /undefined/);
    assert.match(verdict.message, /连接中断/);
  });
});
