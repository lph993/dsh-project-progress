/**
 * AI 建树的模型调用（宿主侧唯一出口）。
 *
 * 形态照抄 DSH 自己的 `dsh-session-title-llm`（那是"插件里怎么正确调一次模型"的
 * 官方样板）：`ctx.llm.stream(options)` + `BlockAssembler`，用 `deadline` 限时，
 * 只发文本消息（来源 kind 由 `shared/message.ts` 统一提供 —— 0.3.1 曾在这里写已退役的
 * `kind: "plugin"`，被宿主 v4 准入拒绝后**中断整个回合**）。
 *
 * 这里**不做确认与预算**：那两件事由上层（service / 面板确认框）负责，
 * 免得"能不能花钱"的判断散落在调用点（§9.5 T1–T3 的收口纪律）。
 */

import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';

import { pmUserMessage } from '../shared/message.ts';
import {
  classifyFinish,
  isOutputLimitReason,
  isTruncatedCompletion,
  parseTreeResponse,
  type ParseOutcome,
} from './parse.ts';
import type { AiRoute } from './route.ts';
import type { TokenUsageLike } from './usage.ts';

/** 允许注入的流式实现（单测用假模型；生产走 `ctx.llm.stream`）。 */
export interface LlmStreamLike {
  stream(options: {
    provider: string;
    model: string;
    messages: unknown[];
    system?: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncIterable<unknown>;
}

export interface BuildTreeCallInput {
  ctx: Context;
  route: AiRoute;
  system: string;
  user: string;
  /**
   * 输出上限（token）。**省略 = 跟随宿主**：适配器会按该模型配置的上限自己 materialize
   * （`LlmResolvedModelInfo.defaultMaxTokens`）—— 用户口径："上限应该和 harness 参数持平"。
   * 只有用户显式设了预算闸门时才传具体数字。
   */
  maxTokens?: number | undefined;
  signal?: AbortSignal;
  /** 测试注入点：给了就用它，不再查 `ctx.llm`。 */
  stream?: LlmStreamLike;
  /**
   * **运行中的进度回调**（FR-167）：每收到一段输出就叫一次，带上"已生成的字符数"。
   *
   * 只给**事实**（字符数）—— 折算成 token 是调用方的事（沿用同一套粗估口径，
   * 见 `ai/progress.ts`）。回调里**不许抛**：它只是展示，不能因为它把建树搞挂。
   */
  onProgress?: (info: { outputChars: number }) => void;
}

export interface BuildTreeCallOk {
  ok: true;
  parsed: Extract<ParseOutcome, { ok: true }>;
  /** 模型原始输出（诊断用；只在失败/审计时展示截断片段）。 */
  rawText: string;
  /** 提供方回报的真实用量（拿不到就是 undefined，**不编**）。 */
  usage?: TokenUsageLike;
}

export interface BuildTreeCallFail {
  ok: false;
  /** 结构化原因，便于上层区分"没模型/超时/截断/输出不合法"。 */
  reason: 'llm-unavailable' | 'call-failed' | 'empty-output' | 'invalid-output' | 'truncated' | 'aborted';
  message: string;
  rawText?: string;
  /** 失败/取消也已经烧了 token —— 有提供方用量就如实交出去。 */
  usage?: TokenUsageLike;
}

export type BuildTreeCallResult = BuildTreeCallOk | BuildTreeCallFail;

/** 从 `ctx` 取 llm 服务（缺失返回 undefined，不抛）。 */
export function llmStreamOf(ctx: Context): LlmStreamLike | undefined {
  try {
    const service = (ctx as unknown as { get?: (key: string) => unknown }).get?.('llm') as
      | LlmStreamLike
      | undefined;
    return typeof service?.stream === 'function' ? service : undefined;
  } catch {
    return undefined;
  }
}

/** `callModelText` 的失败原因（`truncated` 不在其中：那是"文本完整性"的判断，由各调用方按自己的处置决定）。 */
export type ModelTextFailReason = 'llm-unavailable' | 'call-failed' | 'empty-output' | 'aborted';

export interface ModelTextOk {
  ok: true;
  text: string;
  /** 终止原因（已从 finish 块里挖出来；**没读到就是 undefined，不编**）。 */
  finishReason?: string;
  usage?: TokenUsageLike;
}

export interface ModelTextFail {
  ok: false;
  reason: ModelTextFailReason;
  message: string;
  /** 失败/取消时**已经收到的文本**（续跑缓存靠它；空就不给）。 */
  text?: string;
  usage?: TokenUsageLike;
}

export type ModelTextResult = ModelTextOk | ModelTextFail;

/**
 * **只调一次模型、把文本与终止原因交出来**（0.3.61 抽出）。
 *
 * ## 为什么必须抽出来（这是"只修一条路"的又一处）
 *
 * 0.3.60 把"终止原因必须先看"修进了建树路径，但**修复（`aiPlanRepair`）与归拢
 * （`regroupShardedBranches`）各自手写了一模一样的 for-await 循环**，两边都：
 * 只累 `text-delta`、不读 `finish` ⇒
 *
 * - `finish=aborted`（用户取消）⇒ 半份输出被当成正常完成；
 * - `finish=error`（超窗/配额）⇒ provider 的原话丢失；
 * - `finish=max-tokens` 但已吐出的 JSON 恰好配平 ⇒ **半份方案被当成完整方案**，
 *   而归拢是**自动应用**的（不弹确认），等于按半套分组搬节点。
 *
 * 所以把"调一次、收文本、判终止"收口到这里一处。三个调用方各自只决定
 * **"撞上限时算不算失败"**：
 * - 建树：撞上限 ⇒ `truncated`（会走分批重试）；
 * - 修复/归拢：撞上限 ⇒ 直接失败（半份方案不许应用）。
 */
export async function callModelText(input: BuildTreeCallInput): Promise<ModelTextResult> {
  const llm = input.stream ?? llmStreamOf(input.ctx);
  if (llm === undefined) {
    return {
      ok: false,
      reason: 'llm-unavailable',
      message: '宿主没有可用的 llm 服务（ctx.llm 缺失），无法发起 AI 建树。',
    };
  }

  const message = pmUserMessage(input.user);

  let text = '';
  /** 终止原因（`stop` / `length` …）：`length` 意味着输出被 token 上限截断。 */
  let finishReason: string | undefined;
  /**
   * 组装器提到 try 外面：**失败/取消也要读它**。
   *
   * 提供方在流末尾回 `usage`，而"失败"经常发生在 usage 之后（比如输出不合法）——
   * 把 assembler 关在 try 里就等于把"这次花了多少"丢掉了。
   */
  const assembler = new BlockAssembler();
  /**
   * 运行中的字符计数（FR-167）：**只累计 text-delta 的文本长度**，不重新解析 blocks。
   * 目的是"实时看得见"，不是"精确计量" —— 精确值等 usage 回来（那时才是真数）。
   */
  let streamedChars = 0;
  const reportProgress = (): void => {
    if (input.onProgress === undefined) return;
    try {
      input.onProgress({ outputChars: streamedChars });
    } catch {
      // 进度回调只是展示：它出错不该影响这次调用（宁可没有进度条，也不能把建树搞挂）
    }
  };
  try {
    for await (const chunk of llm.stream({
      provider: input.route.provider,
      model: input.route.model,
      messages: [message],
      system: input.system,
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })) {
      assembler.push(chunk as never);
      const delta = readTextDelta(chunk);
      if (delta !== '') {
        streamedChars += delta.length;
        reportProgress();
      }
    }
    const blocks = assembler.blocks() as Array<{ type: string; text?: string }>;
    text = assemblerText(blocks);
    finishReason = readFinishReason((assembler as unknown as { finish?: unknown }).finish);
  } catch (error) {
    const aborted = input.signal?.aborted === true;
    const usage = readUsage(assembler);
    /**
     * **中途抛错也要把已经组装出来的文本交出去**（T9 的字面要求："取消也要把已得结果落盘"）。
     *
     * 这里曾经有个真缺口（被 e2e 抓出来）：`text` 只在**循环正常跑完**之后才赋值，
     * 所以"跑到一半被 abort"这条路径上 `text` 还是空串 ⇒ `rawText` 缺失 ⇒ **续跑缓存没写**，
     * 于是"取消不浪费已得结果"对最常见的取消方式（中途中止）根本不成立。
     * 现在两条路径共用同一个读法（`assemblerText`）。
     */
    /**
     * **中途抛错也要把已经组装出来的文本交出去**（T9 的字面要求："取消也要把已得结果落盘"）。
     *
     * 这里曾经有个真缺口（被 e2e 抓出来）：`text` 只在**循环正常跑完**之后才赋值，
     * 所以"跑到一半被 abort"这条路径上 `text` 还是空串 ⇒ `rawText` 缺失 ⇒ **续跑缓存没写**，
     * 于是"取消不浪费已得结果"对最常见的取消方式（中途中止）根本不成立。
     * 现在两条路径共用同一个读法（`assemblerText`）——
     * 顺带实测确认：`BlockAssembler` 对 `text-delta` 是**边收边组装**的，
     * 就算永远等不到 `block-end`（中途中止就是这样）也能取到已收到的文本
     * （这一条是用"把这里的兜底删掉、断言应当变红"验证过的，不是推测）。
     */
    if (text.trim() === '') {
      text = assemblerText(assembler.blocks() as Array<{ type: string; text?: string }>);
    }
    return {
      ok: false,
      reason: aborted ? 'aborted' : 'call-failed',
      message: aborted
        ? 'AI 建树已取消。'
        : `模型调用失败：${error instanceof Error ? error.message : String(error)}`,
      ...(text.trim() !== '' ? { text } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  const usage = readUsage(assembler);
  /**
   * **终止原因必须先看，再看文本**（0.3.60，对抗/并发处理）。
   *
   * `dsh-llm` 用**终止 finish 块**报告取消与失败（`{kind:'aborted'}` / `{kind:'error', failure:…}`），
   * **不是抛异常**。原来的实现只在"解析失败"那条分支里读 `finishReason` ⇒ 正常跑完的路径从不检查：
   *
   * - **用户取消**（还带着半截文本）⇒ 被当成 `truncated` ⇒ 面板写"可以在设置里提高输出上限"，
   *   而 `SHARD_RETRY_REASONS` 里包含 `truncated` ⇒ **还会继续分批重试**（白花钱）；
   * - **provider 报错**（超窗/配额/鉴权）⇒ 文本为空 ⇒ 变 `empty-output`，
   *   真实原话（含 `maximum context length is N tokens`）被丢掉 ⇒
   *   `learnContextWindowFrom` 学不到窗口 ⇒ 同一个超窗错误会重复发生。
   *
   * 所以这里先分类：**取消就是取消、报错就是报错**，都不许被伪装成"输出被截断"。
   */
  const finishClass = classifyFinish(finishReason);
  if (finishClass === 'aborted' || input.signal?.aborted === true) {
    return {
      ok: false,
      reason: 'aborted',
      message: 'AI 建树已取消。',
      ...(text.trim() !== '' ? { text } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  if (finishClass === 'error') {
    return {
      ok: false,
      reason: 'call-failed',
      /** 把 provider 的原话带出去：超窗/配额/鉴权都靠这句话定位。 */
      message: `模型调用失败（终止原因：${finishReason ?? '未知'}）。${text.trim().slice(0, 200)}`.trim(),
      ...(text.trim() !== '' ? { text } : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  if (text.trim() === '') {
    return {
      ok: false,
      reason: 'empty-output',
      // 这句要能被使用者**据以行动**：常见原因是模型/路由不可用（换了模型名、该 provider 没配额）、
      // 或提示词被安全策略截断。只说"没有返回内容"等于把人留在原地。
      message:
        '模型没有返回任何文本内容（空响应）。可能是模型/供应商不可用、该模型不支持这种长提示词，'
        + '或本次请求被中断。建议：确认设置页的 AI 模型可用后重试，或换一个模型。',
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /**
   * 文本完整性（是否撞上限）**不在这里判**：建树、修复、归拢对"半份输出"的处置不同，
   * 各自按 `isOutputLimitReason(finishReason)` 决定。这里只交事实。
   */
  return {
    ok: true,
    text,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * 调一次模型并解析成树。
 *
 * @returns 成功时返回解析结果；失败时返回**结构化原因**（绝不抛给路由层）
 */
export async function callTreeBuilder(input: BuildTreeCallInput): Promise<BuildTreeCallResult> {
  const got = await callModelText(input);
  if (!got.ok) {
    /**
     * `got.reason` 与 `BuildTreeCallFail.reason` 的前四项完全一致，**直接透传** ——
     * 再写一份映射表就是"同一件事两处实现"，迟早多出第三种说法。
     */
    return {
      ok: false,
      reason: got.reason,
      message: got.message,
      ...(got.text !== undefined ? { rawText: got.text } : {}),
      ...(got.usage !== undefined ? { usage: got.usage } : {}),
    };
  }
  const text = got.text;
  const finishReason = got.finishReason;
  const usage = got.usage;
  const parsed = parseTreeResponse(text);
  if (!parsed.ok) {
    /**
     * 明确区分"被 token 上限截断"和"模型就是没给 JSON"：
     * 前者可修（调高上限 / 建更小的树），后者要用户看到模型到底说了什么。
     *
     * 判据必须**窄**：早先用 `/[{[]/.test(text)`（只要出现花括号就算截断），
     * 于是几乎每次失败都附带一句"似乎被截断"，而终止原因还是个对象 → 显示成
     * `[object Object]`，纯属误导（实测被用户抓到）。
     */
    /**
     * **截断判据只此一处**（`parse.ts::isTruncatedCompletion`）：终止原因命中"撞上限"的各种写法
     * （`length` / `max-tokens` / `max_tokens` / `token-limit` …），**或**文本括号不配平。
     *
     * 真机踩过的坑：提示文案用的是"或"，原因码却只用了 `finishReason === 'length'`
     * ⇒ 供应商回 `max-tokens` 时，**同一份输出**被同时说成"被截断"（给用户看）与
     * "不符合要求"（给机器读）。一个事实两处判据，迟早互相矛盾。
     */
    const truncated = isTruncatedCompletion({ finishReason, text });
    const hint = truncated
      ? `模型输出似乎被截断（终止原因：${finishReason ?? '未知'}）。` +
        '可以在设置里提高 AI 输出上限，或先建更小的树。'
      : '模型没有按格式返回 JSON。';
    return {
      ok: false,
      /**
       * **判据与那句提示同源**（共用一个 `truncated`，见上面的说明）：
       * 被截断就该报 `truncated`，不能混进 `invalid-output`。
       *
       * 为什么要分开：分批重试**只对"规模导致的失败"有意义**。
       * 混在一起时，"模型压根没按格式答（写了一段解释）"也会被判成 `invalid-output` ⇒
       * 触发分批 ⇒ 拿同一份提示词再问 N 次，**白花钱**（实测：一条 e2e 因调用次数从 4 变 6 而报红，
       * 正是这次分类不准暴露出来的）。
       */
      reason: truncated ? 'truncated' : 'invalid-output',
      message: `模型输出不符合要求：${parsed.error} ${hint}`,
      // 交给调用方**完整文本**（它会存成 partial 缓存供续跑）；
      // 展示层自己截断（UI 只显示前 300 字），别在这里先把续跑的可能性砍掉
      rawText: text,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  /**
   * **被截断就不许当成功**，哪怕模型吐出来的 JSON 恰好括号配平（0.3.60）。
   *
   * 现场形状：模型先输出一棵完整的树，后面还想追加第二个对象/说明，被输出上限切断 ——
   * `extractJsonObject` 取到第一个完整对象并判成功 ⇒ **半棵树直接落库**，
   * 不触发分批重试、notes 里一句提示都没有，用户以为"这次就是全部"。
   */
  if (isOutputLimitReason(finishReason)) {
    return {
      ok: false,
      reason: 'truncated',
      message:
        `模型输出撞到上限（终止原因：${finishReason ?? '未知'}）—— 只拿到一部分树，` +
        '按"不完整"处理（会走分批重试）。可以在设置里提高 AI 输出上限。',
      rawText: text,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
  return { ok: true, parsed, rawText: text, ...(usage !== undefined ? { usage } : {}) };
}

/**
 * 从组装好的块里取出**纯文本**（成功路径与"中途失败也要留已得内容"共用一处）。
 *
 * 抽出来的理由不只是去重：两处各写一遍时，失败路径曾经**忘了**取（`text` 还是空串），
 * 于是一取消就把已得内容丢了（见下面 catch 里的注释）。
 */
function assemblerText(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/**
 * 从流式块里读"这一段文本**有多长**"（FR-167 的进度源）。
 *
 * 只认 `text-delta`：`block-end` 里带的是**整块**文本（再算一遍就会重复计数），
 * `reasoning-delta` 之类不是最终输出，也不该计入"已生成"。
 */
export function readTextDelta(chunk: unknown): string {
  if (chunk === null || typeof chunk !== 'object') return '';
  const record = chunk as { type?: unknown; text?: unknown };
  if (record.type !== 'text-delta') return '';
  return typeof record.text === 'string' ? record.text : '';
}

/**
 * 读提供方回报的用量（`BlockAssembler.usage`）。
 *
 * 只取我们要用的字段并**钳成非负数**：提供方给负数/NaN 时宁可当没有，
 * 也不让统计页面出现奇怪数字。
 */
export function readUsage(assembler: BlockAssembler): TokenUsageLike | undefined {
  const raw = (assembler as unknown as { usage?: TokenUsageLike }).usage;
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
  const pick = (value: number | undefined): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  const usage: TokenUsageLike = {};
  const input = pick(raw.inputTokens);
  const output = pick(raw.outputTokens);
  const total = pick(raw.totalTokens);
  const cacheRead = pick(raw.cacheReadTokens);
  const cacheWrite = pick(raw.cacheWriteTokens);
  const reasoning = pick(raw.reasoningTokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (total !== undefined) usage.totalTokens = total;
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * 从 `BlockAssembler.finish` 里读出终止原因。
 *
 * 实测它**不是字符串**（是对象），直接拼接会得到 `[object Object]` ——
 * 用户看到的"终止原因：[object Object]"就是这么来的。这里把常见形状都挖出来。
 */
function readFinishReason(finish: unknown): string | undefined {
  if (typeof finish === 'string') return finish;
  if (finish === null || finish === undefined) return undefined;
  if (typeof finish === 'object') {
    const record = finish as Record<string, unknown>;
    for (const key of ['reason', 'finishReason', 'kind', 'type', 'code']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    try {
      return JSON.stringify(finish).slice(0, 60);
    } catch {
      return undefined;
    }
  }
  return String(finish);
}

