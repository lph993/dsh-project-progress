/**
 * **根节点归位必须能过领域层的 `C13`**（0.3.39 真机现场）。
 *
 * ## 现场
 *
 * 真机日志（0.3.38 补的诊断信息直接把它指出来了）：
 *
 * ```
 * 根节点归位失败（提根）：C13：项目根唯一：已存在顶级节点「Web 服务端」
 * ```
 *
 * `mutateReparent` 的检查表写着「**提升为根时已有活根 ⇒ C13**」——
 * 所以"把项目本体提为根"这条路**只要根已存在就永远走不通**。
 * 我一开始按"项目本体是枝就能提、是光杆才不行"分情况，**判断错了**；
 * 真机上那个项目本体有 6 个子节点（是枝），照样被 C13 挡下。
 *
 * ## 所以修成"提根失败 ⇒ 降级旧根"
 *
 * 把当前根整枝挂到项目本体下面：根数 1 → 1，不触发 C13，**一个节点都不丢**。
 * 这条测试就是钉住这个退路真的能走通（而不是只钉"我写了代码"）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext, fakeAiStream } from './fake-host.ts';

test('根节点归位：现行领域模型下做不到时，必须如实报告且不动树（0.3.40）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pm-normalize-'));
  const ctx = createFakeContext({ workspace: ws });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  /** 让模型路由可用（与 `plugin-smoke` 的 AI 用例同一套最小配置）。 */
  ctx.services.set('agentDefaultModel', {
    currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }),
  });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('该用例应当走注入的假流');
    },
  });
  const service = ctx.services.get('projectManager') as {
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    normalizeProjectRoot(sessionId: string | undefined): Promise<{ moved: number; reason: string }>;
    board(sessionId?: string, root?: string): Promise<{
      projectName: string;
      nodes: Array<{ id: string; name: string; parentId: string | null }>;
    }>;
  };

  /**
   * 造一棵**真机形状**的树：根 = 某个端（「Web 服务端」），
   * 而项目本体（与 projectName 同名）是它的**子节点、且是枝**（有子节点）。
   */
  const json = JSON.stringify({
    projectName: 'PEIS 体检管理系统',
    nodes: [
      { name: 'Web 服务端', kind: 'feature', parent: null, weight: 8 },
      { name: '前端界面框架', kind: 'feature', parent: 0, weight: 5 },
      { name: 'PEIS 体检管理系统', kind: 'feature', parent: 0, weight: 9 },
      { name: '体检业务办理', kind: 'feature', parent: 2, weight: 6 },
      { name: '移动端', kind: 'feature', parent: 2, weight: 4 },
    ],
  });
  const built = await service.aiBuildTree({ stream: fakeAiStream(json), forceRebuild: true });
  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built)}`);

  const before = await service.board();
  const rootsBefore = before.nodes.filter((n) => n.parentId === null);
  assert.equal(rootsBefore.length, 1, '前置：建完应当是 1 个根');
  assert.equal(rootsBefore[0]?.name, 'Web 服务端', '前置：根是"某个端"（这样才需要归位）');
  const body = before.nodes.find((n) => n.name === 'PEIS 体检管理系统');
  assert.ok(body, '前置：项目本体必须在树里');
  assert.equal(body.parentId, rootsBefore[0]?.id, '前置：项目本体是根的子节点');

  /**
   * **现行领域模型下"事后归位"做不到**（0.3.40 实测定性）。
   *
   * 两条路都被领域层的**正确约束**封死：
   *
   * - 提根 ⇒ `C13：项目根唯一`（不许造第二个根）；
   * - 降级旧根 ⇒ `E_CYCLE：不能挂到自己的子孙下面`（**旧根正是项目本体的父**）。
   *
   * 所以正确行为是：**如实报告做不到、一个节点都不搬**，而不是假装修、也不是抛错。
   * 这条测试钉的就是这个"诚实的失败" —— 顺带钉住"不许悄悄改坏树"。
   */
  const attempt = await service.normalizeProjectRoot(undefined);
  assert.equal(attempt.moved, 0, '**做不到就不许搬节点**：' + JSON.stringify(attempt));
  assert.match(
    attempt.reason,
    /C13|E_CYCLE|无法执行/,
    '报告必须说清"为什么做不到"（否则用户只会看到"点了没变化"）：' + JSON.stringify(attempt),
  );

  const after = await service.board();
  const rootsAfter = after.nodes.filter((n) => n.parentId === null);
  assert.equal(rootsAfter.length, 1, '**单根不变量必须保持**（归位失败也不许把树弄成两个根）');
  assert.equal(
    after.nodes.length,
    before.nodes.length,
    '**失败不许丢节点**（归位是整理，整理不成也要原样保留）',
  );
  const bodyAfter = after.nodes.find((n) => n.name === 'PEIS 体检管理系统');
  assert.ok(bodyAfter, '项目本体仍在树里');
  assert.equal(bodyAfter.parentId, rootsAfter[0]?.id, '结构保持原样（没修成，也没改坏）');

  ctx.disposeAll();
  rmSync(ws, { recursive: true, force: true });
});
