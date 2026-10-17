/**
 * **单根形状下"归位做不到"必须如实报告**（0.3.43 自查补的覆盖）。
 *
 * ## 为什么单独立一条
 *
 * `normalizeProjectRoot` 有两个分支：
 *
 * - **多根**（分批建树每片各自成根）⇒ 把"端"降级到本体下（`tests/e2e/root-collapse.test.ts` 已覆盖）；
 * - **单根 + 本体是它的子节点** ⇒ **靠 `reparentNode` 做不到**，只能如实报告。
 *
 * 后一条我写完就只靠"代码读起来对"来相信它 —— 而这正是 0.3.40 的教训
 * （`collected` 那个 `ReferenceError` 也是"读起来对"）。所以补这条。
 *
 * ## 为什么"做不到"是确定的（不是没实现）
 *
 * 形状 `旧根 R → 本体 B`（`B.parent === R`）：
 *
 * - 提 B 为根 ⇒ `C13：项目根唯一`；
 * - 把 R 挂到 B 下 ⇒ **`E_CYCLE`** —— B 的祖先链里就有 R，父挂到子下必然成环。
 *
 * 这不是"再想想办法"能解决的，是树的性质。所以产品行为应当是
 * **明确告诉用户只能重建**，而不是静默失败或把树改坏。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext, fakeAiStream } from './fake-host.ts';

test('单根形状下归位做不到时：如实报告、不动树、不抛错（0.3.43）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pm-single-root-'));
  const ctx = createFakeContext({ workspace: ws });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('该用例应当走注入的假流');
    },
  });
  const service = ctx.services.get('projectManager') as {
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    normalizeProjectRoot(sessionId: string | undefined): Promise<{ moved: number; reason: string }>;
    patchNode(input: Record<string, unknown>): Promise<{ status: string }>;
    addNode(input: Record<string, unknown>): Promise<{ status: string }>;
    board(sessionId?: string, root?: string): Promise<{
      nodes: Array<{ id: string; name: string; parentId: string | null }>;
    }>;
  };

  /**
   * 第一步：先造一棵**正常**的树 —— 项目本体当根（0.3.41 的整形负责这一步）。
   */
  const json = JSON.stringify({
    projectName: 'PEIS 体检管理系统',
    nodes: [
      { name: 'Web 服务端', kind: 'feature', parent: null, description: '网站端' },
      { name: 'PEIS 体检管理系统', kind: 'feature', parent: 0, description: '项目本体' },
      { name: '体检登记', kind: 'feature', parent: 1, description: '登记功能' },
      { name: '报告打印', kind: 'feature', parent: 1, description: '打印功能' },
    ],
  });
  const built = await service.aiBuildTree({ stream: fakeAiStream(json), forceRebuild: true });
  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 300)}`);

  const shaped = await service.board();
  const rootAfterShape = shaped.nodes.filter((n) => n.parentId === null);
  assert.equal(rootAfterShape.length, 1, '前置：整形后应当是单根');
  assert.equal(rootAfterShape[0]?.name, 'PEIS 体检管理系统', '前置：0.3.41 的整形把本体扶成了根');

  /**
   * 第二步：把树改成 **"像整形没生效的旧树"** 的形状 ——
   *
   * 1. 根改名成「Web 服务端」（像某个端）；
   * 2. **再挂一个子节点叫「PEIS 体检管理系统」**（与项目名同源 ⇒ 归位判据会命中它）。
   *
   * 这就是 0.3.41 之前真机那种形状（`根=端`、`项目名是它的子节点`）。
   * 用它验：归位判定命中、但**单根形状下靠 `reparentNode` 做不到** ⇒ 必须如实报告且不动树。
   */
  const renamed = await service.patchNode({
    nodeId: rootAfterShape[0]?.id,
    patch: { name: 'Web 服务端' },
  });
  assert.equal(renamed.status, 'ok', '前置：改名应当成功');
  const addedBody = await service.addNode({
    parentId: rootAfterShape[0]?.id,
    name: 'PEIS 体检管理系统',
    kind: 'feature',
    description: '项目本体（模拟旧树把本体挂成了子节点）',
  });
  assert.equal(addedBody.status, 'ok', '前置：挂"像项目名的子节点"应当成功');

  const before = await service.board();
  assert.equal(before.nodes.filter((n) => n.parentId === null).length, 1, '前置：仍是单根');

  const attempt = await service.normalizeProjectRoot(undefined);
  assert.equal(attempt.moved, 0, `单根形状下不许搬节点：${JSON.stringify(attempt)}`);
  /**
   * **必须说清"为什么做不到"** —— 用户看到的不能是空白或"成功"。
   * 0.3.40 的教训：`{"moved":0,"reason":"归位失败（提根）：denied"}` 这种话等于没说。
   */
  assert.match(
    attempt.reason,
    /C13|E_CYCLE|无法|做不到/,
    `报告必须能用来排除可能性：${JSON.stringify(attempt)}`,
  );

  /** **不动树**：节点数、根数、父子关系全不许变。 */
  const after = await service.board();
  assert.equal(after.nodes.length, before.nodes.length, '归位失败不许丢节点');
  assert.equal(
    after.nodes.filter((n) => n.parentId === null).length,
    1,
    '归位失败不许把树弄成两个根',
  );
  for (const node of before.nodes) {
    const now = after.nodes.find((n) => n.id === node.id);
    assert.equal(now?.parentId, node.parentId, `「${node.name}」的父节点不许被改动`);
  }

  ctx.disposeAll();
  rmSync(ws, { recursive: true, force: true });
});
