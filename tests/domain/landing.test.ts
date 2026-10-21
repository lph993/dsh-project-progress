/**
 * **落点判定**（0.3.56，真机事故驱动）。
 *
 * ## 事故现场（2026-10-21）
 *
 * 用户重生成了 PEIS 的树，结果树上同时出现 PEIS 的 `PEIS.Web/Areas/...` 与
 * **插件自己仓库的** `src/ai` / `docs/开发须知.md` / `lib`；而
 * `pm_20a91cfe`（`E:\thirty\dsh-project-progress` 那个项目）**被改名成了「PEIS」**。
 *
 * 根因：读的仓库（`resolveRoot`）与写的项目（全局 `projectId`）不同源。
 *
 * ## 为什么是纯函数
 *
 * 我先写了一体化 e2e 去复现整件事，**注入验证时它不变红**（前置条件没成立 ⇒ 假测试）。
 * 判定抽成纯函数后就能被可靠地测到；`applyAiTree` 只剩几行接线。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideLandingRebind, normalizeRootForCompare } from '../../src/domain/landing.ts';

describe('落点判定：写之前要不要按"本次读的仓库"重新绑定', () => {
  it('项目根与本次仓库**不同** ⇒ 必须重绑（这就是真机那一幕）', () => {
    const decision = decideLandingRebind('E:\\thirty\\dsh-project-progress', 'E:\\CSP\\PEIS\\PEIS');
    assert.equal(decision.rebind, true, '读 PEIS 却绑在插件仓库的项目上 ⇒ 必须纠正');
    assert.match(decision.reason, /不一致/);
    /** 理由要能让人看懂后果，否则下一个人会把这条判定删掉。 */
    assert.match(decision.reason, /别的仓库的项目/);
  });

  it('同一路径的**写法差异**不算不同仓库（反斜杠 / 大小写 / 尾斜杠）', () => {
    assert.equal(
      decideLandingRebind('E:\\CSP\\PEIS\\PEIS', 'e:/csp/peis/peis/').rebind,
      false,
      '归一后相同 ⇒ 不许重绑（否则每次建树都白重绑一次）',
    );
    assert.equal(normalizeRootForCompare('E:\\A\\B\\'), 'e:/a/b');
  });

  it('本次没声明仓库 ⇒ **不判**（不猜、不重绑）', () => {
    assert.equal(decideLandingRebind('E:\\CSP\\PEIS\\PEIS', '').rebind, false);
    assert.equal(decideLandingRebind('E:\\CSP\\PEIS\\PEIS', '   ').rebind, false);
    assert.match(decideLandingRebind('E:\\x', '').reason, /没声明/);
  });

  it('当前项目的根是**空**的（旧 meta）⇒ 也要重绑到本次仓库', () => {
    const decision = decideLandingRebind('', 'E:\\CSP\\PEIS\\PEIS');
    assert.equal(decision.rebind, true, '项目根不明时，宁可按本次仓库重绑，也不要写到不明项目里');
    assert.match(decision.reason, /（空）/);
  });
});
