/**
 * **AI 修复方案的解析与校验**（0.3.21）。
 *
 * 这一层的存在理由只有一个：**模型给的东西不许直接进执行路径**。
 * 所以要钉住的不是"能不能解析"，而是**边界**：
 *
 * 1. **id 白名单**：动作里出现的 id 必须在发给它的清单里 —— 编出来的 id 当场作废；
 * 2. **动作集封闭**：`kind` 只许取 `REPAIR_ACTION_KINDS`；
 * 3. **必填字段**：merge 要 intoNodeId、rename 要 newName、split 要 suggestedChildren…；
 * 4. **作废要留痕**：被拒的动作进 `rejected`，不是静默丢弃 ——
 *    "AI 什么都没提"与"AI 提了但都在编"是两种完全不同的结论，界面必须能分辨。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRepairPlan } from '../../src/ai/repair-parse.ts';

const IDS = ['n1', 'n2', 'n3'];

/** 造一个模型回复（JSON 字符串）。 */
const reply = (obj: unknown): string => JSON.stringify(obj);

describe('parseRepairPlan：白名单与动作集（不许编、不许越界）', () => {
  it('合法的六种动作都能采纳', () => {
    const out = parseRepairPlan(
      reply({
        summary: '整体尚可，三处语义重复',
        actions: [
          { kind: 'merge', nodeId: 'n1', intoNodeId: 'n2', reason: '同一件事' },
          { kind: 'move', nodeId: 'n3', toParentId: 'n2', reason: '层级错位' },
          { kind: 'rename', nodeId: 'n1', newName: '新名字', reason: '名不副实' },
          { kind: 'describe', nodeId: 'n2', newDescription: '新描述', reason: '过时' },
          { kind: 'split', nodeId: 'n3', suggestedChildren: ['甲', '乙'], reason: '塞了两件事' },
          { kind: 'delete', nodeId: 'n1', reason: '空壳' },
        ],
      }),
      IDS,
    );
    assert.equal(out.summary, '整体尚可，三处语义重复');
    assert.equal(out.actions.length, 6);
    assert.deepEqual(
      out.actions.map((a) => a.kind),
      ['merge', 'move', 'rename', 'describe', 'split', 'delete'],
    );
    assert.equal(out.rejected.length, 0);
  });

  it('**编出来的 id 一律作废并留痕**（这是本层最重要的职责）', () => {
    const out = parseRepairPlan(
      reply({
        actions: [
          { kind: 'merge', nodeId: 'n1', intoNodeId: '不存在', reason: '编的' },
          { kind: 'rename', nodeId: '编造的id', newName: 'x', reason: '编的' },
          { kind: 'delete', nodeId: 'n1', reason: '真空壳' },
        ],
      }),
      IDS,
    );
    assert.equal(out.actions.length, 1, '只有 id 合法的那条被采纳');
    assert.equal(out.actions[0]?.kind, 'delete');
    assert.equal(out.rejected.length, 2);
    assert.ok(out.rejected.every((r) => r.reason.includes('不在清单里')));
  });

  it('非法的 kind 与缺字段的动作都作废，且各自说明理由', () => {
    const out = parseRepairPlan(
      reply({
        actions: [
          { kind: '删除', nodeId: 'n1', reason: '中文 kind 不在封闭集里' },
          { kind: 'rename', nodeId: 'n1', reason: '缺 newName' },
          { kind: 'split', nodeId: 'n1', suggestedChildren: [], reason: '空子清单' },
          { kind: 'merge', nodeId: 'n1', intoNodeId: 'n1', reason: '自己并自己' },
          { kind: 'move', nodeId: 'n1', toParentId: 'n1', reason: '自己挂自己' },
        ],
      }),
      IDS,
    );
    assert.equal(out.actions.length, 0);
    assert.equal(out.rejected.length, 5);
    assert.ok(out.rejected.some((r) => r.reason.includes('非法的动作类型')));
    assert.ok(out.rejected.some((r) => r.reason.includes('缺 newName')));
    assert.ok(out.rejected.some((r) => r.reason.includes('没给 suggestedChildren')));
    assert.ok(out.rejected.some((r) => r.reason.includes('目标就是它自己')));
    assert.ok(out.rejected.some((r) => r.reason.includes('目标父就是它自己')));
  });

  it('模型没给理由时不编造：填"(模型未给理由)"', () => {
    const out = parseRepairPlan(reply({ actions: [{ kind: 'delete', nodeId: 'n2' }] }), IDS);
    assert.equal(out.actions.length, 1);
    assert.equal((out.actions[0] as { reason: string }).reason, '(模型未给理由)');
  });

  it('容忍 markdown 围栏与前后闲话（模型常见形态）', () => {
    const fenced = '好的，这是我的判断：\n```json\n' + reply({ actions: [{ kind: 'delete', nodeId: 'n3', reason: 'x' }] }) + '\n```\n以上。';
    const out = parseRepairPlan(fenced, IDS);
    assert.equal(out.actions.length, 1, '围栏与闲话不该让整份输出作废');
  });

  it('输出根本不是 JSON 对象 ⇒ 整份作废并留痕（不抛）', () => {
    const out = parseRepairPlan('我觉得这棵树挺好的', IDS);
    assert.equal(out.actions.length, 0);
    assert.equal(out.rejected.length, 1);
    assert.ok(out.rejected[0]?.reason.includes('不是 JSON 对象'));
  });

  it('uncertain 原样保留；**id 编造的"拿不准"被丢掉但留痕**', () => {
    const out = parseRepairPlan(
      reply({
        actions: [],
        uncertain: [
          { nodeIds: ['n1', 'n2'], question: '这两枝是不是同一件事，我拿不准' },
          { nodeIds: ['不存在的'], question: 'id 编的 ⇒ 无法定位，丢掉但要留痕' },
        ],
      }),
      IDS,
    );
    assert.equal(out.actions.length, 0);
    assert.equal(out.uncertain.length, 1, '只有能定位的那条留下');
    assert.deepEqual(out.uncertain[0]?.nodeIds, ['n1', 'n2']);
    assert.equal(out.rejected.length, 1, '被丢掉的那条必须留痕，不能静默消失');
    assert.ok(out.rejected[0]?.reason.includes('不可定位'));
  });
});
