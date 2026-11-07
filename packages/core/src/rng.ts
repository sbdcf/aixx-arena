/**
 * 确定性随机数：同一 seed 必须产出同一份卷子，这是「同种子同卷」与复盘的前提。
 * 用 mulberry32：32 位状态、无依赖、实现只有几行，出错时肉眼可查。
 */

/**
 * @param seed 任意整数；内部会取低 32 位无符号
 * @returns [0, 1) 上的伪随机序列
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fisher-Yates 洗牌，不修改入参。
 */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** 从数组里等概率取一个；空数组返回 undefined。 */
export function pickOne<T>(items: readonly T[], rand: () => number): T | undefined {
  if (items.length === 0) return undefined
  return items[Math.floor(rand() * items.length)]
}
