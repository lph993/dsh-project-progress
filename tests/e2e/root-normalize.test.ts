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

test('建树时就把根扶正：根是端、项目本体是它的子节点 ⇒ 重排（0.3.41）', async () => {
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
  const noteText = JSON.stringify(built['notes'] ?? []);
  assert.match(
    noteText,
    /根节点整形/,
    '整形必须留下说明（否则用户不知道树被重排过）：' + noteText.slice(0, 400),
  );

  /**
   * **建树过程里就该把根扶正**（0.3.41：改在**落库前**）。
   *
   * 落库后修不了 —— 提根被 `C13：项目根唯一` 挡、降级旧根被 `E_CYCLE` 挡
   * （旧根正是项目本体的父）。所以整形必须发生在模型输出上。
   */
  const after = await service.board();
  const rootsAfter = after.nodes.filter((n) => n.parentId === null);
  assert.equal(rootsAfter.length, 1, '**单项根不变量**：只能有一个根');
  assert.equal(
    rootsAfter[0]?.name,
    'PEIS 体检管理系统',
    '**根必须是项目本体**（建树阶段就该扶正）：' +
      `实际根=「${rootsAfter[0]?.name}」，全树=${JSON.stringify(after.nodes.map((n) => n.name))}`,
  );
  assert.equal(after.nodes.length, 5, '整形只改层级方向：**节点一个都不许丢**（原样 5 个）');
  const demoted = after.nodes.find((n) => n.name === 'Web 服务端');
  assert.ok(demoted, '旧根不许被丢掉（降级 ≠ 删除）');
  assert.equal(demoted.parentId, rootsAfter[0]?.id, '旧根降级为项目本体的子节点');
  const movedChild = after.nodes.find((n) => n.name === '前端界面框架');
  /**
   * 用户口径："**Web服务端没有存在的必要**" ⇒ 旧根的子节点**提到新根下**，
   * 整层包装消掉；旧根自己退成一个叶（不删：删除是破坏性操作）。
   */
  assert.equal(
    movedChild?.parentId,
    rootsAfter[0]?.id,
    '旧根原有的子节点必须提到新根下（不再被包装层吞一层）',
  );
  assert.deepEqual(
    after.nodes.filter((n) => n.parentId === demoted.id).map((n) => n.name),
    [],
    '旧根不许再挂着子节点（那正是用户要消掉的层级）',
  );
  const bodyChild = after.nodes.find((n) => n.name === '体检业务办理');
  assert.equal(bodyChild?.parentId, rootsAfter[0]?.id, '项目本体原有的子节点保持不动');

  ctx.disposeAll();
  rmSync(ws, { recursive: true, force: true });
});
