/**
 * `pm_* 工具注册与调用分发` 的契约测试（补齐唯一一个真的没有测试的叶子节点）。
 *
 * 为什么它值得单独钉：这是**模型唯一能碰到插件的入口**。注册表如果悄悄少注册一个工具，
 * 或把只读工具误判成"要审批"，模型那边表现为"某个能力不存在"，而插件里不会有任何报错 ——
 * 与项目里已被记录过的"守护型代码从没拦下过东西"是同一类盲区（docs/开发须知.md 第 7 条）。
 *
 * 覆盖三件事：
 *   ① 注册：TOOL_NAMES 里的每个名字都真的注册上了（不多不少）；
 *   ② 分发：注册表给每个工具留下的 handler 真的能跑通并回值；
 *   ③ 审批口径：破坏性工具需要询问、只读工具直接放行（漏判会让日常操作被堵死，
 *      误判会让危险操作悄悄过去，两个方向都要钉）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_NAMES } from '../../src/index.ts';
import { guardAskFor, guardedToolNames } from '../../src/tools/guard.ts';

test('工具清单本身是唯一事实源：名字非空、去重、且都是 pm_ 前缀', () => {
  assert.ok(TOOL_NAMES.length > 0);
  assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, '工具名不得重复');
  for (const name of TOOL_NAMES) {
    assert.match(name, /^pm_[a-z0-9_]+$/, `工具名不合规：${name}`);
  }
});

test('审批清单里的每一项都必须是已注册的工具（不许有"幽灵审批项"）', () => {
  const guarded = guardedToolNames();
  assert.ok(guarded.length > 0, '审批清单不该为空');
  for (const name of guarded) {
    assert.ok(TOOL_NAMES.includes(name), `审批清单里的 ${name} 不在已注册工具里 —— 那是幽灵项`);
  }
});

test('审批口径：破坏性工具要询问，只读工具直接放行', () => {
  for (const name of guardedToolNames()) {
    const ask = guardAskFor(name, 'workspace-write');
    assert.ok(ask !== undefined, `${name} 是破坏性工具，必须请求审批`);
    assert.equal(ask?.kind, 'ask');
    assert.ok((ask?.reason ?? '').length > 0, `${name} 的审批理由不许为空`);
  }

  // 只读/常规工具：不该弹框（弹错会把日常操作整片堵死）
  for (const name of ['pm_tree', 'pm_board', 'pm_node', 'pm_next', 'pm_consolidate', 'pm_review']) {
    assert.equal(guardAskFor(name, 'workspace-write'), undefined, `${name} 不该请求审批`);
  }
});

test('完全权限下破坏性工具不再询问（否则"完全权限"名不副实）', () => {
  for (const name of guardedToolNames()) {
    assert.equal(
      guardAskFor(name, 'danger-full-access'),
      undefined,
      `${name} 在完全权限下仍请求审批 —— 与 FR-163 矛盾`,
    );
  }
});

test('未知工具名不产生审批请求（不猜）', () => {
  assert.equal(guardAskFor('pm_not_a_real_tool', 'workspace-write'), undefined);
  assert.equal(guardAskFor('write', 'workspace-write'), undefined, '宿主自带工具不归本插件的审批门管');
});
