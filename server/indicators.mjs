/**
 * Pure-math day-trading technical indicators (zero dependencies).
 */

export function sma(values, period) {
  if (!values || values.length < period || period <= 0) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function emaLast(values, period) {
  if (!values || values.length < period || period <= 0) return null;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  for (let i = period; i < values.length; i++) {
    prev = (values[i] - prev) * k + prev;
  }
  return prev;
}

export function rsi(values, period = 14) {
  if (!values || values.length < period + 1) return null;
  const gains = new Array(values.length).fill(0);
  const losses = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains[i] = diff;
    else losses[i] = -diff;
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < values.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trs = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const c = bars[i];
    const p = bars[i - 1];
    trs[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  let val = 0;
  for (let i = 1; i <= period; i++) val += trs[i];
  val /= period;
  for (let i = period + 1; i < bars.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
  }
  return val;
}

export function adx(bars, period = 14) {
  const n = bars?.length || 0;
  if (n < 2 * period + 1) return null;
  const tr = new Array(n).fill(0);
  const pdm = new Array(n).fill(0);
  const mdm = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    const pc = bars[i - 1].close;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  let trS = 0, pS = 0, mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i];
    pS += pdm[i];
    mS += mdm[i];
  }
  const dx = [];
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + pdm[i];
      mS = mS - mS / period + mdm[i];
    }
    if (trS <= 0) {
      dx.push(0);
      continue;
    }
    const pdi = (100 * pS) / trS;
    const mdi = (100 * mS) / trS;
    dx.push(pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0);
  }
  if (dx.length < period) return null;
  let val = 0;
  for (let i = 0; i < period; i++) val += dx[i];
  val /= period;
  for (let i = period; i < dx.length; i++) {
    val = (val * (period - 1) + dx[i]) / period;
  }
  return val;
}

export function classicPivots(prevDay) {
  const P = (prevDay.high + prevDay.low + prevDay.close) / 3;
  const R1 = 2 * P - prevDay.low;
  const S1 = 2 * P - prevDay.high;
  const R2 = P + (prevDay.high - prevDay.low);
  const S2 = P - (prevDay.high - prevDay.low);
  return { P, R1, R2, S1, S2 };
}

export function resampleBars(bars, bucketMinutes) {
  const bucketMs = bucketMinutes * 60 * 1000;
  const map = new Map();
  for (const b of bars) {
    const key = Math.floor(b.timeMs / bucketMs) * bucketMs;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        timeMs: key,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume || 0,
      });
    } else {
      if (b.high > existing.high) existing.high = b.high;
      if (b.low < existing.low) existing.low = b.low;
      existing.close = b.close;
      existing.volume += b.volume || 0;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timeMs - b.timeMs);
}
