import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRepairPlan } from '../../src/ai/repair-parse.ts';

test('动作里的 id 写成 `#id` / `[#id]` 也必须被接受（0.3.59）', () => {
  /**
   * 提示词把节点渲染成 `- 名字 [#pm_xxx]`，并明写「`#id` 是动作里必须原样引用的 id」。
   * 解析器原来只收裸 id ⇒ 模型照提示词输出就被判「nodeId 不在清单里（不许编）」，
   * 面板显示"AI 提了但都在编"，而真相是提示词与解析器各说各话。
   */
  const plan = parseRepairPlan(
    JSON.stringify({
      summary: '整理',
      actions: [
        { kind: 'delete', nodeId: '#n1', reason: '重复' },
        { kind: 'move', nodeId: '[#n2]', toParentId: '#n1', reason: '层级错位' },
        { kind: 'merge', nodeId: 'n2', intoNodeId: '#n1', reason: '同义' },
      ],
    }),
    ['n1', 'n2'],
  );
  assert.equal(plan.actions.length, 3, `三种写法都要认（实际：${JSON.stringify(plan.rejected)}）`);
  assert.deepEqual(
    plan.actions.map((a) => a.nodeId),
    ['n1', 'n2', 'n2'],
  );
});

test('真正的编造 id 仍然必须被拒（归一不是放宽）', () => {
  const plan = parseRepairPlan(
    JSON.stringify({ actions: [{ kind: 'delete', nodeId: '#nope', reason: 'x' }] }),
    ['n1'],
  );
  assert.equal(plan.actions.length, 0, '不在清单里的 id 不许混进来');
  assert.equal(plan.rejected.length, 1);
  assert.match(plan.rejected[0]?.reason ?? '', /不在清单里/);
});