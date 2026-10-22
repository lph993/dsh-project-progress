/**
 * **建树请求失败之后该说什么**（0.3.63，真机现场驱动；纯函数，可单测）。
 *
 * ## 现场
 *
 * 一次分批建树的 HTTP 请求挂了 **11 分 36 秒**。宿主/浏览器把连接掐断，面板只拿到
 * `Failed to fetch` —— 而服务端日志显示**树已经建好**（77 个节点），汇总行都打出来了。
 *
 * 用户看到红字，最自然的反应是**再点一次** ⇒ 白花一整轮的钱（上一轮是真金白银买来的树）。
 *
 * ## 所以：先核对事实，再决定说什么
 *
 * 连接断掉只说明"这个响应没回来"，**不说明服务端没做完**。正确做法是刷新看板，
 * 用 `aiRun.phase` 这个服务端的真实状态来判断：
 *
 * | 看板 | 结论 |
 * |---|---|
 * | 拿不到 | 事实不明 ⇒ 明说"可能仍在跑"，并禁止急着重试 |
 * | `aiRun.phase === 'done'` | **其实成功了** ⇒ 按成功呈现，说明连接中断 |
 * | 其它（running / error / 没有 aiRun） | 仍在跑或已失败 ⇒ 让用户等进度，别重试 |
 */

export type BuildFetchVerdict =
  /** 服务端其实已经建完：按成功呈现。 */
  | { kind: 'completed'; message: string }
  /** 事实不明或仍在跑：**不要重试**。 */
  | { kind: 'unknown'; message: string };

export interface BuildFetchFacts {
  /** 客户端拿到的原始错误（通常是 `Failed to fetch`）。 */
  error: string;
  /** 刷新看板得到的事实；拿不到就传 `undefined`（不许猜）。 */
  board?: { runPhase?: string | undefined; nodeCount?: number | undefined };
}

/** 同一个工作区重试一次的代价提醒。 */
const DONT_RETRY = '**别急着重试** —— 重试会让模型再花一整轮的钱。';

export function describeBuildFetchFailure(facts: BuildFetchFacts): BuildFetchVerdict {
  const raw = facts.error.trim() === '' ? '连接中断' : facts.error;
  if (facts.board === undefined) {
    return {
      kind: 'unknown',
      message: `${raw}\n建树可能仍在后台跑：等看板刷新确认结果，${DONT_RETRY}`,
    };
  }
  if (facts.board.runPhase === 'done') {
    const count = facts.board.nodeCount;
    return {
      kind: 'completed',
      message:
        'AI 建树**已完成**（连接中断，已从看板确认）。' +
        (typeof count === 'number' ? `\n当前 ${count} 个节点。` : '') +
        '\n详情见看板与诊断页（/pm/debug）。',
    };
  }
  /** `error` / `running` / 没有 aiRun：都不许当成完成，也不许催用户重试。 */
  return {
    kind: 'unknown',
    message: `${raw}\n建树可能仍在后台跑（看板进度尚未显示结束）：等进度条走完再判断，${DONT_RETRY}`,
  };
}
