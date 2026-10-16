/**
 * **数值宽容转换**（0.3.18 起，0.3.28 抽成独立模块）。
 *
 * ## 为什么值得单独一个文件（兼"为什么当初必须做它"）
 *
 * 真机事故取证：一次工具调用的参数被拆成 531 个流式片断，拼出来的 JSON 里
 * `"progress": "0.3"` —— **数字被写成带引号的字符串**，整串 JSON 因此非法，
 * 宿主以 `MALFORMED_RESPONSE` **中断整个回合**（那一轮工作全丢）。
 *
 * 这一类的形态在插件侧可以兜住：schema 声明 number，而 `"0.3"` 语义上就是 0.3。
 *
 * ## 为什么抽出来（0.3.28 的真实教训）
 *
 * 原先工具侧那份实现在 `src/tools/index.ts` 里、**未导出**，于是
 * `tests/tools/number-of.test.ts` 只能**复刻一份**同名函数 —— 两边漂移不会被发现，
 * **那条防线实际不设防**（独立审查指出）。
 *
 * 我把真实现 `export` 出去之后，测试**通过 import 拖进了整个工具模块**，
 * 而那个模块依赖 `@deepseek-ai/dsh-tools`（仓库 `node_modules` 里是别的机器的
 * `link:` 路径，一直解析不了）⇒ **6 个测试文件直接加载失败**。
 *
 * 教训：**被测试直接引用的纯函数，不能住在有宿主依赖的模块里。**
 * 现在它无依赖，工具侧与测试都从这里取同一份实现。
 */

/**
 * 读一个可能是数字或"数字字符串"的值。
 *
 * ## 边界（不许变成"什么都收"）
 *
 * 只接受**能读成有限数**的字符串/数字；`''`、`'跑了一半'`、`NaN`、`Infinity` 一律
 * 返回 `undefined`（调用方据此当作"没给"），**绝不猜**。
 */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * **进度值归一**：宽容转换 + **夹紧到 [0,1]**（0.3.27）。
 *
 * 为什么夹紧而不是拒绝：模型给 `1.5` / `-0.1` 这类越界值时，旧行为是**整条写入失败**
 * （schema 校验不过 ⇒ 那一项白写）。夹到边界比"什么都不记"更符合直觉，也不会让
 * 一次汇总里 49 项成功、第 50 项因数值越界整项丢掉。语义上 `1.5` 就是"满了"。
 */
export function clampProgress(value: unknown): number | undefined {
  const parsed = numberOf(value);
  if (parsed === undefined) return undefined;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}
