/**
 * **"这一轮建树还在不在跑"的判据**（0.3.64）。
 *
 * 用户真机反馈两条，都指向同一个判据错了：
 * ① "生成树时没有停止功能" —— 停止按钮长在弹窗里，而弹窗在生成期间根本没渲染；
 * ② "看着生成按钮没变化（没有处于生成中），树却在变化" —— 按钮只看本面板那次请求，
 *    请求被掐断后立刻恢复空闲态，而宿主还在逐片落库。
 *
 * 这里钉住判据本身：**任一来源说在跑，就算在跑**。宁可多显示一次"正在生成"，
 * 也不能在树还在变的时候把按钮恢复成空闲态（那会诱发"再点一次"的重复花钱）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAiBuildGenerating, isAiBuildResultFor } from '../../src/client/build-state.ts';

test('本面板那次请求还在飞 ⇒ 正在生成', () => {
  assert.equal(isAiBuildGenerating(true), true);
  assert.equal(isAiBuildGenerating(true, undefined), true);
  // 即使宿主还没开始调模型（没有进度快照），本地面板也必须显示"生成中"
  assert.equal(isAiBuildGenerating(true, { aiRun: null }), true);
});

test('宿主说它在跑 ⇒ 正在生成（哪怕本面板的请求已经断了）', () => {
  assert.equal(
    isAiBuildGenerating(false, { aiBuildRunning: true, aiRun: null }),
    true,
    '这正是用户报的现场：按钮空闲、树还在变',
  );
  assert.equal(
    isAiBuildGenerating(false, { aiBuildRunning: true, aiRun: { phase: 'done' } }),
    true,
    '宿主事实优先于进度阶段：收尾阶段（根归位/体检）快照可能已是 done，但这一轮还没结束',
  );
});

test('旧宿主没有 aiBuildRunning ⇒ 退回进度阶段判断', () => {
  assert.equal(isAiBuildGenerating(false, { aiRun: { phase: 'running' } }), true);
  assert.equal(isAiBuildGenerating(false, { aiRun: { phase: 'done' } }), false, '正常结束：进度条留着，但不再算"生成中"');
  assert.equal(isAiBuildGenerating(false, { aiRun: { phase: 'error' } }), false, '失败/取消：同样不再算生成中');
  assert.equal(isAiBuildGenerating(false, { aiRun: null }), false);
  assert.equal(isAiBuildGenerating(false, {}), false, '什么都没报 ⇒ 不猜，按"没在跑"');
});

test('别的项目在建树时本项目的看板为 false（按项目过滤由宿主完成）', () => {
  assert.equal(
    isAiBuildGenerating(false, { aiBuildRunning: false, aiRun: null }),
    false,
    '宿主对"不是这一轮的那个项目"如实回 false，客户端不许自行推断',
  );
});

/**
 * **异步建树的收尾判据**（0.3.70）：`aiLastBuild` 是全局的，上一轮结果会一直留着 ——
 * 面板必须靠"发起时刻"分辨"这是不是我这一轮的结果"。
 */
test('异步结果归属：只认不早于发起时刻的结果（容忍 2 秒时钟差）', () => {
  const startedAt = Date.parse('2026-11-05T00:00:10.000Z');
  assert.equal(
    isAiBuildResultFor('2026-11-05T00:00:10.000Z', startedAt),
    true,
    '同一时刻：是我的',
  );
  assert.equal(
    isAiBuildResultFor('2026-11-05T00:00:12.000Z', startedAt),
    true,
    '完成时间晚于发起：当然是我的',
  );
  assert.equal(
    isAiBuildResultFor('2026-11-05T00:00:08.500Z', startedAt),
    true,
    '2 秒内的时钟差要容忍（宿主/浏览器时钟不可能完全一致）',
  );
  assert.equal(
    isAiBuildResultFor('2026-11-04T23:50:00.000Z', startedAt),
    false,
    '十分钟前的结果 —— 那是上一轮的，不能拿它收尾',
  );
  assert.equal(isAiBuildResultFor(undefined, startedAt), false);
  assert.equal(isAiBuildResultFor('', startedAt), false);
  assert.equal(isAiBuildResultFor('不是时间', startedAt), false, '解析不了 ⇒ 不认（不猜）');
});

