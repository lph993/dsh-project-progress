/**
 * **统一落点核对**（0.3.57）：AI 建树的每条写入路径都必须先核对"项目 = 本次仓库"。
 *
 * ## 为什么要有这条
 *
 * 0.3.56 只在 `applyAiTree` 入口核对，但一次分批建树还会经由
 * `regroupShardedBranches`（addNode/reparentNode）与 `normalizeProjectRoot`（reparentNode）落库。
 * 它们的写入走 `bindForCall(undefined)` ⇒ `operationRoot()` ⇒ **`pendingRoot`
 * （面板最近一次轮询写进去的根）** ⇒ **建树期间别的会话轮询过，归拢就会写到那个仓库**。
 *
 * ## 这条用例怎么保证"真的能变红"
 *
 * 直接调 `ensureLanding`（运行时按形状调用私有方法），用 `debugBinding()` 观测绑定是否真的改了：
 * - 注入（把它改成什么都不做）⇒ 绑定不变 ⇒ 断言失败 ⇒ **红**；
 * - 正常实现 ⇒ 绑定改成目标仓库 ⇒ 绿。
 *
 * 这比"造一个中途拨绑定的场景"可靠 —— 那个场景我试过，前置条件很难成立，注入后仍然全绿（假测试）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFakeContext } from './fake-host.ts';

test('ensureLanding：落点与本次仓库不一致 ⇒ 真的改绑（0.3.57）', async () => {
  const repoA = mkdtempSync(join(tmpdir(), 'pm-ensure-a-'));
  const repoB = mkdtempSync(join(tmpdir(), 'pm-ensure-b-'));
  for (const repo of [repoA, repoB]) {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  }

  const ctx = createFakeContext({ workspace: repoA });
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) });
  ctx.services.set('llm', {
    stream: () => {
      throw new Error('用注入的假流');
    },
  });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    noteWorkspaceRoot(root: string | undefined): void;
    board(): Promise<{ projectName: string }>;
    debugBinding(): { projectId: string; boundRoot: string | undefined; inFlightProject: string | undefined };
    ensureLanding(expectedRoot: string | undefined): Promise<{ rebound: boolean; note?: string }>;
  };

  /** 先真实绑定到 repoA（建一个项目出来）。 */
  service.noteWorkspaceRoot(repoA);
  await service.board();
  const before = service.debugBinding();
  assert.ok(before.boundRoot !== undefined, '前置条件：必须已经绑定到 repoA');

  /** 现在声明"本次要写的是 repoB" ⇒ 必须真的改绑。 */
  const landing = await service.ensureLanding(repoB);
  assert.equal(landing.rebound, true, '**不一致就必须改绑**（不改绑就是 0.3.56 那个坑）');
  assert.match(landing.note ?? '', /落点已纠正/);

  const after = service.debugBinding();
  const norm = (p: string | undefined) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  assert.equal(norm(after.boundRoot), norm(repoB), `绑定必须落到 repoB（实际 ${after.boundRoot}）`);
  assert.notEqual(after.projectId, before.projectId, '项目 id 必须换成 repoB 那个项目');

  /** 一致时不许瞎折腾（否则每次建树都白重绑一次）。 */
  const again = await service.ensureLanding(repoB);
  assert.equal(again.rebound, false, '已经一致 ⇒ 不许再重绑');
  /** 没声明仓库 ⇒ 什么都不做。 */
  const none = await service.ensureLanding(undefined);
  assert.equal(none.rebound, false, '没声明仓库 ⇒ 不猜');

  ctx.disposeAll();
  rmSync(repoA, { recursive: true, force: true });
  rmSync(repoB, { recursive: true, force: true });
});
