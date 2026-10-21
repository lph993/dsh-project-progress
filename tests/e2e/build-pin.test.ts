/**
 * **建树期间必须钉住落点**（0.3.58 —— 2026-10-21 串仓库事故的真根因）。
 *
 * ## 为什么"每次写入前核对"不够（0.3.56 / 0.3.57 的补丁为什么没挡住）
 *
 * `applyAiTree` 里先 `ensureLanding(expectRoot)` 纠正落点，**紧接着** `await this.derive()`；
 * 而 `derive()` 第一行是 `bindForCall(undefined)` ⇒ `operationRoot()`，匿名读那条分支会回落到
 * `lastSessionBound.root`（**另一个会话最近读过的根**）⇒ 刚纠正的落点立刻被改回去。
 *
 * 真机后果：PEIS 的项目里长出插件自己仓库的 `src/ai` / `docs/开发须知.md` 节点，
 * 而插件仓库那个项目被改名成「PEIS」。
 *
 * ## 这条用例怎么保证"能变红"
 *
 * 在**模型调用进行中**（流里）读 `debugBinding().inFlightProject`：
 * 有锁 ⇒ 是一个项目 id；没有锁 ⇒ `undefined`。注入（去掉 `enterOperation()`）⇒ 立刻红。
 * 建树结束后再断言锁已释放 —— 防"忘了解锁导致后续操作被钉在旧项目上"。
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

test('建树期间 inFlightProject 必须是锁上的，结束后必须释放（0.3.58）', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pm-pin-'));
  mkdirSync(join(workspace, 'web'), { recursive: true });
  writeFileSync(join(workspace, 'web', 'index.ts'), 'export const a = 1;\n');

  const ctx = createFakeContext({ workspace });
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
    aiBuildTree(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    debugBinding(): { projectId: string; inFlightProject: string | undefined };
  };
  service.noteWorkspaceRoot(workspace);

  /** 在模型调用进行中采样：此刻必须已经上锁。 */
  const seen: Array<string | undefined> = [];
  let projectIdDuringCall: string | undefined;
  const built = await service.aiBuildTree({
    confirm: true,
    stream: {
      stream: () => {
        const snapshot = service.debugBinding();
        seen.push(snapshot.inFlightProject);
        projectIdDuringCall = snapshot.projectId;
        return streamOf(
          JSON.stringify({
            projectName: '锁演示',
            nodes: [
              { name: '锁演示', kind: 'feature', parent: null, description: '本体' },
              { name: 'Web 入口', kind: 'feature', parent: 0, description: 'web', refs: [{ type: 'dir', target: 'web' }] },
            ],
          }),
        );
      },
    },
  });

  assert.equal(built['status'], 'ok', `建树应当成功：${JSON.stringify(built).slice(0, 300)}`);
  assert.ok(seen.length >= 1, '必须真的调过模型');
  assert.ok(
    seen.every((value) => value !== undefined),
    `**建树期间必须一直上锁**（采样到 ${JSON.stringify(seen)}）—— 没锁就会在建树中途被改绑，这就是真机那次串仓库的原因`,
  );
  assert.equal(
    seen[0],
    projectIdDuringCall,
    '锁必须钉在本次建树的那个项目上（不是别的项目）',
  );

  /** 结束后必须松锁，否则后续别的操作会被钉在旧项目上。 */
  const after = service.debugBinding();
  assert.equal(after.inFlightProject, undefined, '**建树结束后必须释放锁**');

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});

test('嵌套操作不许把外层的落点锁清掉（0.3.59，子代理审查挖出的缺陷）', async () => {
  /**
   * `enterOperation()` 原来只有一个 `inFlightProject` 字段、**没有嵌套计数**：
   *
   * ```ts
   * const pinned = this.projectId;
   * this.inFlightProject = pinned;
   * return () => { if (this.inFlightProject === pinned) this.inFlightProject = undefined; };
   * ```
   *
   * 于是外层（整轮建树）加锁后，内层 `addNode` 的收尾判据 `inFlightProject === pinned` **成立** ⇒
   * **直接把外层的锁清掉**。也就是说 0.3.58 那个"整轮钉住落点"在第一次写入之后就失效了。
   */
  const workspace = mkdtempSync(join(tmpdir(), 'pm-nest-'));
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
    board(): Promise<{ nodes: Array<{ id: string; name: string; parentId: string | null }> }>;
    debugBinding(): { projectId: string; inFlightProject: string | undefined };
    addNode(input: Record<string, unknown>): Promise<{ status: string; nodeId?: string }>;
  };
  service.noteWorkspaceRoot(workspace);
  await service.board();
  const pinned = service.debugBinding().projectId;

  /** 模拟外层操作（建树/AI 建树）先上锁。 */
  const release = (service as unknown as { enterOperation(): () => void }).enterOperation();
  assert.equal(service.debugBinding().inFlightProject, pinned, '外层加锁后应当处于锁定状态');

  /** 内层写一个节点：它自己也会 enterOperation/释放一次。 */
  const added = await service.addNode({ name: '内层节点', kind: 'feature', parentId: null, by: 'session' });
  assert.equal(added.status, 'ok', `内层写入应当成功：${JSON.stringify(added)}`);

  assert.equal(
    service.debugBinding().inFlightProject,
    pinned,
    '**内层释放不许把外层的锁清掉**（没有嵌套计数 ⇒ 这里会变成 undefined，事故链条就恢复了）',
  );

  release();
  assert.equal(service.debugBinding().inFlightProject, undefined, '最外层释放后必须松锁');

  ctx.disposeAll();
  rmSync(workspace, { recursive: true, force: true });
});
