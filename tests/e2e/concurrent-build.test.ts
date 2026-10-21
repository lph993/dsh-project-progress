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

/**
 * **取消意图不许被下一次建树请求抹掉**（0.3.61 审查修正）。
 *
 * ## 原来的 bug（这条测试就是它的形状）
 *
 * `aiBuildTree` 在**拿到单飞闸门之前**就把 `aiCancelRequested` 清零了。于是：
 * 上一轮还在跑 → 用户点「取消」→ 用户以为没反应又点一次「建树」→
 * 第二次先清标记、再被闸门以 `build-in-progress` 拒绝 ⇒ **被取消的那一轮在下一个分片处
 * 读到 `false`，继续把剩下的片跑完**（用户以为取消了，实际还在烧 token）。
 *
 * ## 为什么要造一个"分批"的现场
 *
 * 单次建树被取消后就结束了，没有"下一片"可以观察。所以这里让**第一次调用返回截断**
 * （`reason: 'truncated'` ⇒ 走 `SHARD_RETRY_REASONS` ⇒ 进入分批），
 * 第二个顶层目录就是"下一片"。判据直接数**模型调用次数**：
 * 修好之后 = 2（截断 1 次 + 第 1 片 1 次），修之前 = 3（还会发第 2 片）。
 */
test('取消后又被拒绝一次建树请求 ⇒ 取消意图必须还在，剩下的片不许再发', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-cancel-'));
  /** 两个顶层目录 ⇒ 能切出 2 片（`shardSkeleton` 按顶层目录切）。 */
  for (const dir of ['alpha', 'beta']) {
    mkdirSync(join(workspace, dir), { recursive: true });
    writeFileSync(join(workspace, dir, 'index.ts'), 'export const a = 1;\n');
  }

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
    cancelAiBuild(): { cancelled: boolean };
  };
  service.noteWorkspaceRoot(workspace);

  let calls = 0;
  let shardEntered = false;
  let releaseShard: (() => void) | undefined;
  const shardGate = new Promise<void>((resolve) => {
    releaseShard = resolve;
  });

  const stream = {
    stream: () => {
      calls += 1;
      const call = calls;
      /**
       * 第 1 次：故意给"截断"（不配平 + 撞上限）⇒ 触发分批。
       * 第 2 次（第 1 片）：挂住，等测试取消之后才放行。
       * 第 3 次及以后：不该发生 —— 发生了就说明取消意图被抹掉了。
       */
      return (async function* () {
        if (call === 1) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: '{"projectName":"分批","nodes":[{"name":"根"' };
          yield { type: 'finish', reason: 'max-tokens' };
          return;
        }
        if (call === 2) {
          shardEntered = true;
          await shardGate;
        }
        for await (const chunk of streamOf(okTree('不该被建出来'))) yield chunk;
      })();
    },
  };

  const first = service.aiBuildTree({ confirm: true, stream });
  for (let i = 0; i < 200 && !shardEntered; i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(shardEntered, true, '前置条件：必须已经进入分批的第 1 片');
  assert.equal(calls, 2, `前置条件：此时应当只发过 2 次调用（实际 ${calls}）`);

  /** 用户点「取消」：这一轮确实在跑，必须认。 */
  assert.deepEqual(service.cancelAiBuild(), { cancelled: true });

  /** 用户又点一次「建树」：必须被拒 —— 而且**不许产生副作用**（这正是原来的 bug）。 */
  const second = await service.aiBuildTree({ confirm: true, stream: { stream: () => streamOf(okTree('第二轮')) } });
  assert.equal(second['status'], 'denied', `第二轮必须被拒绝（实际：${JSON.stringify(second).slice(0, 200)}）`);
  assert.equal(second['reason'], 'build-in-progress');

  /** 放行第 1 片：此时 abort 已经生效，结果应当是"被取消"，且**不再发第 2 片**。 */
  releaseShard?.();
  const firstResult = await first;
  assert.notEqual(firstResult['status'], 'ok', `取消之后不许报成功：${JSON.stringify(firstResult).slice(0, 300)}`);
  assert.equal(calls, 2, `取消之后不许再发新的分片（实际发了 ${calls} 次调用）`);

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * **"两次调用之间"点取消也要算数**（0.3.61 审查修正）。
 *
 * `callTreeBuilderWithProgress` 每跑完一次调用就把 `aiBuildAbort` 置空，
 * 于是落库/回填/归拢这段（最慢的一段）里点「取消」，老实现会命中
 * `aiBuildAbort === null` ⇒ 返回 `cancelled:false` 且**不置标记** ⇒ 下一片照发。
 *
 * 那个窗口从外部没法稳定命中（要精确插在两次调用之间），所以这里直接把
 * "这一轮在跑、但没有 abort 控制器"这个中间态摆出来 —— 它正是老实现判错的那个状态。
 */
test('建树在跑但当前没有 abort 控制器 ⇒ 取消仍然必须生效（置标记）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-cancel-idle-'));
  mkdirSync(join(workspace, 'web'), { recursive: true });
  writeFileSync(join(workspace, 'web', 'index.ts'), 'export const a = 1;\n');

  const ctx = createFakeContext({ workspace });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    cancelAiBuild(): { cancelled: boolean };
  };
  const internals = service as unknown as {
    aiBuildRunning: boolean;
    aiCancelRequested: boolean;
    aiBuildAbort: unknown;
  };
  assert.equal(internals.aiBuildRunning, false, '前置条件：没在跑');

  assert.deepEqual(service.cancelAiBuild(), { cancelled: false }, '没在跑时取消是无害的空操作');

  /** 造出"在跑、但控制器已置空"的中间态（分批时两次调用之间就是这样）。 */
  internals.aiBuildRunning = true;
  internals.aiBuildAbort = null;
  assert.deepEqual(
    service.cancelAiBuild(),
    { cancelled: true },
    '这一轮在跑 ⇒ 必须置取消标记（否则剩下的分片会继续发）',
  );
  assert.equal(internals.aiCancelRequested, true, '取消标记必须真的落下去');

  internals.aiBuildRunning = false;
  internals.aiCancelRequested = false;
  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
