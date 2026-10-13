/**
 * **生产者自有的消息来源（producer-owned source kind）**。
 *
 * ## 为什么单独成一个模块
 *
 * 宿主 v4 会话格式**没有**共同的兜底 `kind: "plugin"`：每条消息的来源必须由生产者
 * 自己声明（`dsh-llm` 的 `MessageSource` 注释原话："Merge-extensible sum type ——
 * each producer declares its own `kind` in its own module; **there is no shared
 * catch-all `plugin` kind**"）。而 `plugin` 这个字符串在 v4 里是**已退役**的写法，
 * 准入校验 EXPLICITLY 拒绝它：
 *
 * ```js
 * // dsh-session-format-v3-to-v4/lib/index.js:126
 * if (… || value["kind"] === "plugin")
 *   throw new SessionFormatError("format v4 message requires a producer-owned source kind");
 * ```
 *
 * 该 assertion 由 `assertV4SourceRowAdmission()` 在**逐条**检查持久化事件时调用，
 * 检查的槽位包含 `agent/inbox/spliced` 的 `data.inserted[]`（同文件 `:145-151`）——
 * 也就是说：**插件投一条消息用旧 kind，宿主会把整个回合判失败**
 * （真机报错原文："工具使用有故障 本轮运行失败 format v4 message requires a
 * producer-owned source kind"），而 `inject()` 返回 void、异常在持久化管线里，
 * 插件侧的 `try/catch` 根本等不到它。**0.3.1 就是这么中断了两轮真实工作的。**
 *
 * ## 取值口径（为什么是裸包名，而不是 `plugin:<包名>`）
 *
 * 三种写法在 v4 里都**不被拒绝**（校验只拒空串与字面量 `plugin`），差别在于别人怎么读：
 *
 * | 写法 | 依据 |
 * |---|---|
 * | `dsh-project-progress` | **本仓采用**。与一线插件实测口径一致：`dsh-session-title-llm/lib/index.js:202` 写 `kind: "dsh-session-title-llm"`，`dsh-schedule/lib/index.js:1594` 写 `kind: "schedule"` |
 * | `plugin:dsh-project-progress` | v3→v4 迁移器对**未知插件名**的兜底（`producerKind()` 的 `return \`plugin:${plugin}\``）——那是"替历史数据补票"，不是新代码该模仿的形状 |
 *
 * 轨道视图会把未知 kind 直接首字母大写展示（`dsh-client-ui-trajectory` 的
 * `messageSourceLabel()`），所以裸包名在界面上显示为 "Dsh-project-progress"，
 * **不再是**旧版的"插件"。这是本次修复唯一的显示侧代价，不影响任何逻辑。
 *
 * ## 纪律
 *
 * 运行期构造消息**只能**走 {@link pmUserMessage}——不要在别处再写一遍 `source` 字面量：
 * 本次的 P0 就是因为四处各写了一遍，改名 / 宿主收紧时一处漏改就中断回合。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * 本插件在宿主会话格式里的**生产者身份**（= npm 包名）。
 *
 * 与 `src/index.ts` 的 `PACKAGE_ID`、`src/client/index.tsx` 的 `PACKAGE_ID` 必须同值：
 * 那两处是"包身份"（宿主按它认领客户端 bundle、诊断页按它报名），这里是"消息来源身份"。
 */
export const PM_PRODUCER_KIND = 'dsh-project-progress';

/**
 * v4 对 `MessageSource.kind` 的**可接受性**判据（纯函数，可单测）。
 *
 * 与宿主 `source()`（`dsh-session-format-v3-to-v4/lib/index.js:126`）逐字对齐：
 * 非空字符串，且不是已退役的字面量 `plugin`。
 *
 * 之所以要在插件侧再写一遍：宿主那条 assertion 抛在持久化管线里，**插件看不见**
 * （见本模块顶部）。这里是"发出去之前先自证"，把不可观测的回合中断变成一条本地诊断。
 */
export function isAdmissibleSourceKind(kind: unknown): boolean {
  return typeof kind === 'string' && kind.length > 0 && kind !== 'plugin';
}

/**
 * 构造一条**宿主管线会接受**的 user 角色消息（本插件全部运行期消息的唯一构造入口）。
 *
 * @param text - 模型可见的正文。
 * @returns 带生产者自有 `kind` 的 user 消息。
 * @throws Error 当 `kind` 不满足 v4 准入（不可能发生，除非有人改坏了 {@link PM_PRODUCER_KIND}）——
 *   宁可在此**同步抛出**（投递方 `try/catch` 能看见、能落诊断），也不要让它到宿主那里
 *   变成一次静默的回合中断。
 */
export function pmUserMessage(text: string): ReturnType<typeof createUserMessage> {
  if (!isAdmissibleSourceKind(PM_PRODUCER_KIND)) {
    throw new Error(
      `插件消息来源 kind 非法（${String(PM_PRODUCER_KIND)}）：v4 只接受生产者自有的非空 kind，` +
        '且拒绝已退役的字面量 "plugin"；否则宿主会拒绝整条事件并中断回合',
    );
  }
  return createUserMessage({
    content: [{ type: 'text', text }],
    /**
     * ⚠️ **这里必须断言**（0.3.13 由类型检查抓出：TS2322）。
     *
     * `@deepseek-ai/dsh-llm` 的 `MessageSource` 取自 `MessageSourceMap`
     * （只有 `user` / `model` / `tool` / `system-prompt` 四个内置条目），
     * 而它自己的文档写着这张表是 **merge-extensible**（"switch on `kind` and fall through unknowns"）——
     * 运行期**确实**接受生产者自有的非空 kind（v4 准入只拒绝已退役的 `"plugin"`），
     * 我们这条链路的正确性也由上面的 `isAdmissibleSourceKind` 自证 + `tests/shared/message.test.ts` 钉住。
     * 缺的只是**类型表没登记我们的 kind**，所以断言收在这一处（不散到四个调用点）。
     *
     * 为什么不用 declaration merging 去扩 `MessageSourceMap`：那会全局影响宿主与其它插件
     * 对这张表的理解（它们可能按"只有四种"穷举分支），代价远大于这里一次收口断言。
     */
    source: { kind: PM_PRODUCER_KIND } as unknown as ReturnType<
      typeof createUserMessage
    >['source'],
  });
}
