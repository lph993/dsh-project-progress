/**
 * **分批建树的"整轮收口"**（0.3.61）。
 *
 * 背景：`deferGlobalScope` 让分片期间只落库、不判定；等所有片跑完，再用
 * **所有片提案的并集**清一次草稿、标一次 `stale`。这里钉两件事：
 *
 * 1. **有片失败 ⇒ 不收口**。并集不完整时，"没被提到"可能只是那一片没跑成；
 *    拿残缺的并集去清，等于把还没重建的区域删掉（比不收缩更糟）。
 *    ⚠️ 旧实现是在**第一片**就按"本片提到过"清 —— 那条路径下，这一片失败就会连带删掉别的片。
 * 2. **全部片成功 ⇒ 收口真的发生**。整轮没再提到的、已经推进过的自动节点要标 `stale`
 *    （只标不删）；否则大仓库（必然分批）的"只增不减"永远修不好。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext } from './fake-host.ts';

interface BoardNode {
  name: string;
  stale?: boolean;
}

const shardTree = (name: string, extra: Array<Record<string, unknown>> = []) =>
  JSON.stringify({
    projectName: '分片演示',
    nodes: [
      { name: '分片演示', kind: 'feature', parent: null, description: '项目本体' },
      {
        name,
        kind: 'feature',
        parent: 0,
        description: `${name} 的业务`,
        refs: [{ type: 'dir', target: name === '甲' ? 'alpha' : 'beta' }],
        ...(extra[0] ?? {}),
      },
      ...extra,
    ],
  });

/** 第一次调用故意给"截断"，把流程推进分批路径（与执行路径的判据一致：truncated 会重试分批）。 */
const truncatedOnce = () => ({
  type: 'text-delta' as const,
  text: '{"projectName":"分片演示","nodes":[{"name":"根"',
});

async function setup(workspace: string) {
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
    board(): Promise<{ nodes: BoardNode[] }>;
  };
  service.noteWorkspaceRoot(workspace);
  return { ctx, service };
}

/**
 * 按调用序号编排模型输出：1=截断，2=甲，3=乙（或第 3 次直接抛错）。
 *
 * ⚠️ 计数器必须在 `stream()` **外面**（每次调用都会重新进 `stream()`；
 * 放里面就等于每次都从 1 开始，第二片永远跑不到 —— 我第一版就这么写错，
 * 于是"该红"的注入验证反而是绿的）。
 */
const scripted = (third: 'ok' | 'throw', shardBody: string) => {
  let call = 0;
  return {
    stream: () => {
      call += 1;
      const current = call;
      return (async function* () {
        if (current === 1) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield truncatedOnce();
          yield { type: 'finish', reason: 'max-tokens' };
          return;
        }
        if (current === 2) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: shardBody };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: shardBody } };
          yield { type: 'finish', reason: 'stop' };
          return;
        }
        if (third === 'throw') throw new Error('第 2 片失败（模拟）');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: shardBody };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: shardBody } };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
};

test('有分片失败 ⇒ 跳过收口，别的片的节点不许被删（旧实现会在第一片就删）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-shard-fail-'));
  for (const dir of ['alpha', 'beta']) {
    mkdirSync(join(workspace, dir), { recursive: true });
    writeFileSync(join(workspace, dir, 'index.ts'), 'export const a = 1;\n');
  }
  const { ctx, service } = await setup(workspace);

  /** 第一轮：两片都成功 —— 树上出现「甲」「乙」（进度都是 0，属于"没人动过的自动节点"）。 */
  const firstStream = {
    stream: (() => {
      let call = 0;
      return async function* () {
        call += 1;
        const body = call === 1 ? '' : call === 2 ? shardTree('甲') : shardTree('乙');
        if (call === 1) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield truncatedOnce();
          yield { type: 'finish', reason: 'max-tokens' };
          return;
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: body };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
        yield { type: 'finish', reason: 'stop' };
      };
    })(),
  };
  const first = await service.aiBuildTree({ confirm: true, stream: firstStream });
  assert.equal(first['status'], 'ok', `第一轮应当成功：${JSON.stringify(first).slice(0, 300)}`);
  const namesOf = async () => (await service.board()).nodes.map((node) => node.name);
  assert.ok((await namesOf()).includes('乙'), '前置条件：第一轮必须建出「乙」');

  /** 第二轮：第 1 片成功、第 2 片失败（单片失败不放弃整轮 ⇒ 整体仍是 ok + failures）。 */
  const second = await service.aiBuildTree({
    confirm: true,
    stream: scripted('throw', shardTree('甲')),
  });
  assert.equal(second['status'], 'ok', `另一片成功时整体算部分成功：${JSON.stringify(second).slice(0, 300)}`);
  assert.ok(
    Array.isArray(second['failures']) && (second['failures'] as unknown[]).length > 0,
    '失败的那一片必须如实写进 failures',
  );
  assert.ok(
    (await namesOf()).includes('乙'),
    '第 2 片失败时，**绝不能**因为第 1 片没提到它就把「乙」删掉（并集不完整 ⇒ 跳过收口）',
  );

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});

test('全部分片成功 ⇒ 整轮没再提到的已推进节点要标 stale（只标不删）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-shard-stale-'));
  for (const dir of ['alpha', 'beta']) {
    mkdirSync(join(workspace, dir), { recursive: true });
    writeFileSync(join(workspace, dir, 'index.ts'), 'export const a = 1;\n');
  }
  const { ctx, service } = await setup(workspace);

  /** 第一轮：除「甲」「乙」外，根下再造一个**已推进**的自动节点「遗留任务」。 */
  const withLegacy = (name: string) =>
    JSON.stringify({
      projectName: '分片演示',
      nodes: [
        { name: '分片演示', kind: 'feature', parent: null, description: '项目本体' },
        {
          name,
          kind: 'feature',
          parent: 0,
          description: `${name} 的业务`,
          refs: [{ type: 'dir', target: name === '甲' ? 'alpha' : 'beta' }],
        },
        name === '甲'
          ? { name: '遗留任务', kind: 'task', parent: 0, description: '上一轮建出来的', progress: 0.5 }
          : { name: '占位', kind: 'task', parent: 0, description: '占位' },
      ],
    });

  const buildOne = (shardName: string) => ({
    stream: (() => {
      let call = 0;
      return async function* () {
        call += 1;
        if (call === 1) {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield truncatedOnce();
          yield { type: 'finish', reason: 'max-tokens' };
          return;
        }
        const body = withLegacy(call === 2 ? '甲' : '乙');
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: body };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
        yield { type: 'finish', reason: 'stop' };
      };
    })(),
    shardName,
  });

  const first = await service.aiBuildTree({ confirm: true, stream: buildOne('甲') });
  assert.equal(first['status'], 'ok', `第一轮应当成功：${JSON.stringify(first).slice(0, 300)}`);

  /**
   * 第二轮：两片都成功，但都不再提「遗留任务」。
   * 旧实现（分批）**永远不标 stale**；新实现应当在收口时标上。
   */
  const second = await service.aiBuildTree({
    confirm: true,
    stream: (() => {
      let call = 0;
      return {
        stream: () => {
          return (async function* () {
            call += 1;
            if (call === 1) {
              yield { type: 'block-start', index: 0, blockType: 'text' };
              yield truncatedOnce();
              yield { type: 'finish', reason: 'max-tokens' };
              return;
            }
            const body = shardTree(call === 2 ? '甲' : '乙');
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: body };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: body } };
            yield { type: 'finish', reason: 'stop' };
          })();
        },
      };
    })(),
  });
  assert.equal(second['status'], 'ok', `第二轮应当成功：${JSON.stringify(second).slice(0, 400)}`);

  const legacy = (await service.board()).nodes.find((node) => node.name === '遗留任务');
  assert.ok(legacy, '「遗留任务」只标不删，必须还在树上');
  assert.equal(legacy?.stale, true, '整轮没再提到的已推进自动节点必须标 stale（分批也要标）');

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
