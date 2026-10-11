/**
 * 成本预估的**措辞**契约（批次 79 补的测试）。
 *
 * ## 为什么值得单独钉
 *
 * 真机现场（AIG，2026-10-11）：骨架没把仓库装下 ⇒ `aiBuildTree` **直接分批**（6 片），
 * 可确认框里仍写着「规模小，成本很低……**预计 1 次调用**、输入约 3536 token」，
 * 而实际发了 6 次、输入 15,830 token。这正是本仓库明令禁止的事：
 * **预估与实际不一致就是在骗人**（T6）。
 *
 * 修法分两步：批次 78 让**数字**按分批合计（2657 条 / 12064 token），
 * 批次 79 让**措辞**跟着走（`plannedShards` → `calls` → `describeEstimate` 换说法）。
 * 这个文件同时钉住"要说对"和"单次路径不许被改坏"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeEstimate, estimateAiBuild } from '../../src/ai/prompt.ts';

test('会直接分批时：调用次数按片数算，并明说"直接分批"而不是"截断才重试"', () => {
  const estimate = estimateAiBuild({
    entries: 2657,
    signatureBytes: 43_000,
    promptBytes: 40_000,
    maxNodes: 60,
    likelyTooLarge: true,
    plannedShards: 6,
  });

  assert.equal(estimate.calls, 6, '片数就是调用次数 —— 不能再写"1 次调用"');

  const text = describeEstimate(estimate);
  assert.match(text, /预计 6 次调用/, `必须按真实片数说：${text}`);
  assert.match(text, /直接按顶层目录分批（6 片）/, '要说明是**直接**分批，不是等失败');
  assert.match(text, /按 6 片合计/, '条目数与输入 token 的口径要说清是按片合计');
  assert.equal(/预计 1 次调用/.test(text), false, '不许再出现"预计 1 次调用"');
  assert.equal(/若这次输出被截断/.test(text), false, '直接分批时不许再说"若被截断才重试"');
});

test('单次路径（没说片数）保持原措辞：1 次调用 + 截断才分批重试', () => {
  const estimate = estimateAiBuild({
    entries: 12,
    signatureBytes: 100,
    promptBytes: 500,
    maxNodes: 60,
    likelyTooLarge: true,
  });

  assert.equal(estimate.calls, 1);
  const text = describeEstimate(estimate);
  assert.match(text, /预计 1 次调用/);
  assert.match(text, /若这次输出被截断/);
  assert.equal(/直接按顶层目录分批/.test(text), false, '没计划分批就不许说有');
});

test('片数为 1 或未给 ⇒ 仍按单次说（不让"1 片"把措辞带偏）', () => {
  for (const plannedShards of [undefined, 1]) {
    const estimate = estimateAiBuild({
      entries: 12,
      signatureBytes: 100,
      promptBytes: 500,
      maxNodes: 60,
      ...(plannedShards !== undefined ? { plannedShards } : {}),
    });
    assert.equal(estimate.calls, 1, `plannedShards=${String(plannedShards)} 时仍是 1 次`);
    assert.match(describeEstimate(estimate), /预计 1 次调用/);
  }
});
