/**
 * **终止原因语义**（0.3.60，对抗/并发处理）。
 *
 * `dsh-llm` 用**终止 finish 块**报告取消与失败（`{kind:'aborted'}` / `{kind:'error'}`），
 * **不是抛异常**；而原实现只在"解析失败"那条分支里读 `finishReason`，正常路径从不检查：
 *
 * - 用户**取消**（还带着半截文本）⇒ 被当成 `truncated` ⇒ 面板写"请提高输出上限"，
 *   而且 `SHARD_RETRY_REASONS` 含 `truncated` ⇒ **还会继续分批重试**（白花钱）；
 * - provider **报错**（超窗/配额/鉴权）⇒ 文本为空 ⇒ 变 `empty-output`，真实原话被丢；
 * - `finish=max-tokens` 但模型已吐出**配平 JSON** ⇒ 判成功，**半棵树直接落库**。
 *
 * 这组用例直接打在 `callTreeBuilder` 上（它接受注入的 `stream`）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { callTreeBuilder } from '../../src/ai/tree-builder.ts';
import type { Context } from '@deepseek-ai/cordis';

const streamWith = (text: string, finish: unknown) =>
  (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: finish };
  })();

const call = async (text: string, finish: unknown, extra: Record<string, unknown> = {}) =>
  callTreeBuilder({
    ctx: {} as Context,
    route: { provider: 'p', model: 'm' } as never,
    system: 'sys',
    user: 'user',
    stream: { stream: () => streamWith(text, finish) },
    ...extra,
  });

const TREE = JSON.stringify({
  projectName: 'X',
  nodes: [{ name: '根', kind: 'feature', parent: null, description: '本体' }],
});

test('finish=aborted ⇒ reason 必须是 aborted（不许被当成截断）', async () => {
  const result = await call(TREE, { kind: 'aborted' });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'aborted', `实际：${JSON.stringify(result).slice(0, 200)}`);
  /** 取消也要把已得内容交出去（续跑缓存靠它）。 */
  assert.ok(result.rawText !== undefined, '取消必须保留已得文本');
});

test('signal 已中止 ⇒ reason 也必须是 aborted（哪怕 finish 说 stop）', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await call(TREE, { kind: 'stop' }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'aborted');
});

test('finish=error ⇒ 归为调用失败，且把 provider 的原话带出来', async () => {
  const result = await call('', { kind: 'error', failure: { message: 'maximum context length is 1048576 tokens' } });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'call-failed');
  assert.match(
    result.ok === false ? result.message : '',
    /error/,
    '**终止原因要出现在消息里**（超窗/配额/鉴权全靠它定位）',
  );
});

test('finish=max-tokens **但已吐出配平 JSON** ⇒ 仍按 truncated 处理（半棵树不许当成功）', async () => {
  const result = await call(TREE, { kind: 'max-tokens' });
  assert.equal(result.ok, false, '撞上限就算成功解析了也必须报不完整');
  assert.equal(result.ok === false && result.reason, 'truncated');
});

test('正常 finish ⇒ 成功（别把正常路径也判成截断）', async () => {
  const result = await call(TREE, { kind: 'stop' });
  assert.equal(result.ok, true, `正常结束必须成功：${JSON.stringify(result).slice(0, 200)}`);
});
