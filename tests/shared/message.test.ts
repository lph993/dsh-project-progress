/**
 * `shared/message.ts` 的回归测试 —— 专门钉住 0.3.1 的 **P0 阻断缺陷**。
 *
 * 缺陷原文：插件在 3 处（4 个位置）运行期构造消息时写 `source: { kind: 'plugin', … }`，
 * 而 v4 只接受**生产者自有**的 kind、**明确拒绝**字面量 `plugin`
 * （`dsh-session-format-v3-to-v4/lib/index.js:126`，经 `assertV4SourceRowAdmission()`
 * 逐条检查 `agent/inbox/spliced` 的 `data.inserted[]`）。
 * 后果不是"一条提醒没送到"，而是**整个回合被判失败、当轮工作全部丢失**，且插件诊断里看不见。
 *
 * 所以这里守两件事：
 * 1. `PM_PRODUCER_KIND` 本身必须过 v4 准入（别把 `plugin` 又写回来）；
 * 2. `pmUserMessage` 造出来的消息 `kind` 必须是它 —— 而不是任何历史写法。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PM_PRODUCER_KIND, isAdmissibleSourceKind, pmUserMessage } from '../../src/shared/message.ts';

test('PM_PRODUCER_KIND 过 v4 准入：非空、且不是已退役的 "plugin"', () => {
  assert.equal(isAdmissibleSourceKind(PM_PRODUCER_KIND), true);
  assert.notEqual(PM_PRODUCER_KIND, 'plugin');
  assert.ok(PM_PRODUCER_KIND.length > 0);
});

test('isAdmissibleSourceKind 与宿主口径逐字对齐', () => {
  // 宿主拒绝的两种：空串 / 非字符串 / 字面量 plugin
  assert.equal(isAdmissibleSourceKind('plugin'), false, '字面量 plugin 是 v4 明令拒绝的写法');
  assert.equal(isAdmissibleSourceKind(''), false, '空 kind 被拒绝');
  assert.equal(isAdmissibleSourceKind(undefined), false);
  assert.equal(isAdmissibleSourceKind(null), false);
  assert.equal(isAdmissibleSourceKind(123), false);
  assert.equal(isAdmissibleSourceKind({ kind: 'plugin' }), false);
  // 宿主接受的：生产者自有的非空 kind（本项目、一线插件、上游迁移兜底三种写法都合法）
  assert.equal(isAdmissibleSourceKind('dsh-project-progress'), true);
  assert.equal(isAdmissibleSourceKind('plugin:dsh-project-progress'), true, '上游迁移器对未知插件名的兜底');
  assert.equal(isAdmissibleSourceKind('dsh-session-title-llm'), true, '一线插件的裸名写法');
});

test('pmUserMessage 造出来的消息：role=user、kind=生产者自有、正文原样', () => {
  const message = pmUserMessage('这段提醒必须能存进会话') as unknown as {
    role: string;
    content: Array<{ type: string; text?: string }>;
    source: { kind: string; plugin?: unknown };
  };
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, PM_PRODUCER_KIND);
  // 旧写法还会多带一个 `plugin` 字段；v4 期已不再需要它，留着只会让"来源到底是什么"有两份答案
  assert.equal('plugin' in message.source, false);
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0]?.type, 'text');
  assert.equal(message.content[0]?.text, '这段提醒必须能存进会话');
});
