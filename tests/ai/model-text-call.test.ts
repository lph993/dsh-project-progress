/**
 * **"调一次模型"的唯一出口**（0.3.61）。
 *
 * 背景：建树、修复、归拢三条 LLM 路径原先各写一份 for-await。0.3.60 只把终止原因
 * 的分类修进了建树那条，另外两条**从不读 `finish`** —— 于是"取消/报错/撞上限"
 * 都会被当成正常完成。修法是把调用收口到 `callModelText`，三者共用。
 *
 * 这里钉住这个出口的事实语义：
 * - 取消（finish 块 / signal）⇒ `reason: 'aborted'`，**且已得文本要带出来**（续跑靠它）；
 * - 报错 ⇒ `reason: 'call-failed'`，**provider 原话必须出现在 message 里**；
 * - 空输出 ⇒ `reason: 'empty-output'`；
 * - 撞上限 ⇒ **不在这里判失败**（`ok: true` + `finishReason`）—— 三条路对"半份输出"的
 *   处置不同（建树要分批重试，归拢必须整份作废），由调用方按 `isOutputLimitReason` 决定。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { callModelText } from '../../src/ai/tree-builder.ts';
import type { Context } from '@deepseek-ai/cordis';

const streamOf = (text: string, finish: unknown) =>
  (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    if (text !== '') yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: finish };
  })();

const call = (text: string, finish: unknown, extra: Record<string, unknown> = {}) =>
  callModelText({
    ctx: {} as Context,
    route: { provider: 'p', model: 'm' } as never,
    system: 'sys',
    user: 'user',
    stream: { stream: () => streamOf(text, finish) },
    ...extra,
  });

describe('callModelText：终止原因的三种"失败"', () => {
  it('finish=aborted ⇒ aborted，且保留已得文本', async () => {
    const result = await call('{"nodes":[', { kind: 'aborted' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'aborted');
    assert.equal(result.ok === false ? result.text : '', '{"nodes":[');
  });

  it('signal 已中止 ⇒ 即便 finish 说 stop 也算 aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await call('{"nodes":[]}', { kind: 'stop' }, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'aborted');
  });

  it('finish=error ⇒ call-failed，provider 原话要带出来', async () => {
    const result = await call('', { kind: 'error', failure: { message: 'maximum context length is 1048576' } });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'call-failed');
    assert.match(result.ok === false ? result.message : '', /error/);
  });

  it('空文本 ⇒ empty-output', async () => {
    const result = await call('', { kind: 'stop' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'empty-output');
  });
});

describe('callModelText：撞上限只交事实，不替调用方下结论', () => {
  it('finish=max-tokens ⇒ ok:true + finishReason（由调用方决定算不算失败）', async () => {
    const result = await call('{"nodes":[]}', { kind: 'max-tokens' });
    assert.equal(result.ok, true, '出口不判成败，只交事实');
    assert.equal(result.ok === true ? result.finishReason : undefined, 'max-tokens');
    assert.equal(result.ok === true ? result.text : undefined, '{"nodes":[]}');
  });
});
