/**
 * **并发改树**（0.3.60）。
 *
 * 这组测的是"两件事同时动同一棵树"时的行为：
 * - 两轮建树并行 ⇒ 必须**拒绝**第二个（否则混合成怪树）；
 * - 建树期间别的会话把绑定拨走 ⇒ 落点必须仍然钉住（0.3.58/0.3.59 的锁）；
 * - 建树结束（含异常/取消）⇒ 闸门与锁都必须释放，否则后续永远被拒。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext } from './fake-host.ts';

const streamOf = (text: string) =>
  (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: 'stop' };
  })();

const okTree = (name: string) =>
  JSON.stringify({
    projectName: name,
    nodes: [
      { name, kind: 'feature', parent: null, description: '本体' },
      { name: '入口', kind: 'feature', parent: 0, description: '入口', refs: [{ type: 'dir', target: 'web' }] },
    ],
  });

test('两轮建树并行 ⇒ 第二个必须被拒绝，且第一个跑完后闸门释放（0.3.60）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-single-'));
  mkdirSync(join(workspace, 'web'), { recursive: true });
  writeFileSync(join(workspace, 'web', 'index.ts'), 'export const a = 1;\n');

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', { stream: () => { throw new Error('用注入的假流'); } });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  service.noteWorkspaceRoot(workspace);

  /** 第一轮：在模型调用里挂住，制造"正在跑"的窗口。 */
  let releaseFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let entered = false;
  const first = service.aiBuildTree({
    confirm: true,
    stream: {
      /**
       * ⚠️ `stream()` **必须是同步函数、返回 async iterable**（返回 Promise 会被当坏形状，
       * 第一轮立刻失败、闸门随即释放，第二轮自然不会被拒 —— 我第一版就这么写错了）。
       */
      stream: () => {
        entered = true;
        return (async function* () {
          await gate;
          for await (const chunk of streamOf(okTree('并发演示'))) yield chunk;
        })();
      },
    },
  });
  /** 等它真的进到模型调用（说明 aiBuildRunning 已置位）。 */
  for (let i = 0; i < 100 && !entered; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(entered, true, '前置条件：第一轮必须已经进入模型调用');

  /** 第二轮：必须被拒绝，而不是并行跑。 */
  const second = await service.aiBuildTree({
    confirm: true,
    stream: { stream: () => streamOf(okTree('第二轮')) },
  });
  assert.equal(second['status'], 'denied', `第二轮必须被拒绝（实际：${JSON.stringify(second).slice(0, 200)}）`);
  assert.equal(second['reason'], 'build-in-progress');
  assert.match(String(second['hint'] ?? ''), /正在跑/, '提示要能照做');

  /** 放行第一轮并等它跑完。 */
  releaseFirst?.();
  const firstResult = await first;
  assert.equal(firstResult['status'], 'ok', `第一轮应当正常完成：${JSON.stringify(firstResult).slice(0, 300)}`);

  /** 闸门必须已释放：第三轮不许再被拒。 */
  const third = await service.aiBuildTree({
    confirm: true,
    stream: { stream: () => streamOf(okTree('第三轮')) },
  });
  assert.equal(third['status'], 'ok', `第一轮结束后闸门必须释放（实际：${JSON.stringify(third).slice(0, 200)}）`);

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});

test('建树中途抛错 ⇒ 闸门也必须释放（否则之后永远被拒）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-single-err-'));
  mkdirSync(join(workspace, 'web'), { recursive: true });
  writeFileSync(join(workspace, 'web', 'index.ts'), 'export const a = 1;\n');

  const ctx = createFakeContext({ workspace });
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', { stream: () => { throw new Error('用注入的假流'); } });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  service.noteWorkspaceRoot(workspace);

  /** 让模型调用直接抛错（在生成器体内抛，才会被当成"调用失败"）。 */
  const failed = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: () =>
        (async function* () {
          throw new Error('模拟建树中途崩溃');
        })(),
    },
  });
  assert.equal(failed['status'], 'error', `应当如实返回错误：${JSON.stringify(failed).slice(0, 200)}`);

  const after = await service.aiBuildTree({
    confirm: true,
    stream: { stream: () => streamOf(okTree('恢复演示')) },
  });
  assert.equal(
    after['status'],
    'ok',
    `崩溃之后闸门必须已经释放（实际：${JSON.stringify(after).slice(0, 200)}）`,
  );

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
