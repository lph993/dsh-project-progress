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

import { isAiBuildGenerating } from '../../src/client/build-state.ts';

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
