/**
 * **同一个工作区根下有多个项目时，必须选"最新的"那个**（0.3.34 真机现场）。
 *
 * ## 现场
 *
 * `e:/CSP/PEIS/PEIS` 下同时存在两个项目：
 * `pm_8d91544e`（刚建树，**36 个节点**，06:14:59）与 `pm_228d6790`（00:52 的空壳）。
 * 而绑定用的是 `projects.find(...)` ⇒ 取列表里**第一个**匹配的 ⇒ 停在空壳上：
 * 用户看到一棵旧树，以为"重建只有这么点节点"，**而新建的 36 个节点在另一个项目里**。
 *
 * ## 判据
 *
 * 两个项目同根、`updatedAt` 不同 ⇒ 绑定必须落在**较新**的那个。
 * 这条不依赖顺序（`find` 的"第一个"取决于存储列举顺序），是确定性判据。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { normalizeRootPath } from '../../src/shared/path.ts';

// 复用 e2e 那套最小假上下文（同款思路；`createFakeContext` 已导出，不再复制一份）
import { createFakeContext } from './fake-host.ts';

test('同根多项目：绑定选最新的那个（0.3.34）', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'pm-same-root-'));
  const ctx = createFakeContext({ workspace: ws });
  const module = (await import('../../lib/index.js')) as {
    apply(ctx: unknown, config: unknown): Promise<void>;
  };
  await module.apply(ctx, {});
  const service = ctx.services.get('projectManager') as {
    board(sessionId?: string, root?: string): Promise<{ projectId: string; nodes: Array<{ id: string }> }>;
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
    listProjects(): Promise<Array<{ projectId: string; workspaceRoot?: string; updatedAt?: string }>>;
    port: {
      putMeta(meta: Record<string, unknown>): Promise<void>;
      getMeta(id: string): Promise<Record<string, unknown> | undefined>;
    };
    projectId: string;
    boundRoot?: string;
    switchProject(id: string, root: string | undefined, sessionId?: string): void;
    boundRootSet?: unknown;
  };

  // 先建一个项目（写一个节点，让它有内容）
  const first = await service.addNode({ parentId: null, name: '旧树', sessionId: 's1' });
  assert.equal(first.status, 'ok', JSON.stringify(first));
  const oldProjectId = service.projectId;
  const oldNodes = (await service.board('s1')).nodes.length;

  /**
   * 造出第二个同根项目（模拟"重建时新建了一个"）。
   *
   * ⚠️ **必须同时登进项目索引**：`listProjects()` 读的是
   * `structure.global().projectIds`，只 `putMeta` 是不够的
   * ——我第一版就漏了这一步，于是"选最新"的代码**根本没机会看到**那个新项目，
   * 测试红了但红得没意义（验的是装置缺陷，不是产品行为）。
   */
  const newId = `pm_test_newer_${Date.now()}`;
  const oldMeta = await service.port.getMeta(oldProjectId);
  assert.ok(oldMeta, '拿不到旧项目 meta');
  const future = new Date(Date.now() + 60_000).toISOString();
  await service.port.putMeta({ ...oldMeta, projectId: newId, updatedAt: future });

  /**
   * 登进项目索引。**这里碰了端口的私有字段 `structure`**（域对象），
   * 因为 `listProjects()` 正是从 `structure.global.get().projectIds` 读的，
   * 而假存储的域对象只挂在端口上、没有别的公开入口。
   * 测试里这样取是刻意的：**要验的就是"同根多项目时选谁"**，绕开它就没法构造场景。
   */
  const portAny = service.port as unknown as {
    structure: {
      global: { get(): { projectIds: string[] }; set(value: unknown): Promise<void> | void };
    };
  };
  const global = portAny.structure.global.get();
  await portAny.structure.global.set({ ...global, projectIds: [...global.projectIds, newId] });
  assert.ok(
    (await service.listProjects()).some((p) => p.projectId === newId),
    '前置：新项目必须已进索引，否则这条测试量的是装置缺陷而不是产品行为',
  );

  // 让绑定失效，迫使下一次解析重新选
  service.boundRoot = undefined;
  const board = await service.board('s1', ws);

  assert.equal(
    normalizeRootPath(String(ws)),
    normalizeRootPath(String((await service.port.getMeta(board.projectId))?.workspaceRoot ?? ws)),
    '前置：读的仍是这个根',
  );
  assert.equal(
    board.projectId,
    newId,
    '**同根多项目时必须选最新的那个**（选错会让用户看到旧的/空的树，以为重建没产出）：' +
      `选中=${board.projectId}，最新=${newId}，旧=${oldProjectId}（旧树有 ${oldNodes} 个节点）`,
  );

  ctx.disposeAll();
  rmSync(ws, { recursive: true, force: true });
});
