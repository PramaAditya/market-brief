import { useEffect, useState } from "react";
import { AssistantWidget } from "./components/AssistantWidget";

interface Asset {
  symbol: string;
  name: string;
  source: string;
  digits: number;
  price: number;
  changePct: number;
  todayHigh: number;
  todayLow: number;
  sma200_1d: number | null;
  pivots: { P: number; R1: number; R2: number; S1: number; S2: number };
  intradayRes1h: number;
  intradaySup1h: number;
  tf15m: { bias: string; rsi14: number | null };
  tf1h: {
    bias: string;
    regime: string;
    ema20: number | null;
    ema50: number | null;
    rsi14: number | null;
    adx14: number | null;
    atr14: number | null;
  };
  tf4h: {
    bias: string;
    regime: string;
    rsi14: number | null;
    adx14: number | null;
    atr14: number | null;
  };
}

interface Snapshot {
  updatedWib: string;
  updatedUtc: string;
  assets: Asset[];
  macroAlerts: { timeWib: string; event: string }[];
  errors: string[];
}

function biasClass(bias: string): string {
  const low = bias.toLowerCase();
  if (low.includes("bull")) return "pos";
  if (low.includes("bear")) return "neg";
  return "muted";
}

function fmt(val: number | null | undefined, digits: number): string {
  if (val == null || Number.isNaN(val)) return "—";
  return val.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadingSnap, setLoadingSnap] = useState(true);
  const [snapErr, setSnapErr] = useState("");

  async function loadSnapshot(force = false) {
    setLoadingSnap(true);
    setSnapErr("");
    try {
      const res = await fetch(force ? "/api/snapshot?refresh=1" : "/api/snapshot");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSnapshot(data);
    } catch (err) {
      setSnapErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSnap(false);
    }
  }

  useEffect(() => {
    loadSnapshot(false);
  }, []);

  return (
    <>
      <main>
        <header>
          <div>
            <h1>Market brief</h1>
            <p className="meta">
              {loadingSnap && !snapshot ? "Memuat data..." : snapshot?.updatedWib || "Belum ada data"}
            </p>
          </div>
          <button
            type="button"
            className="btn"
            disabled={loadingSnap}
            onClick={() => loadSnapshot(true)}
          >
            {loadingSnap ? "Memuat..." : "Muat ulang"}
          </button>
        </header>

        {snapErr && <p className="neg meta">Gagal memuat snapshot: {snapErr}</p>}

        {snapshot && snapshot.macroAlerts.length > 0 && (
          <div className="alert-box" role="alert">
            {snapshot.macroAlerts.map((a, i) => (
              <p key={i}>
                <strong>{a.timeWib}</strong> {a.event}
              </p>
            ))}
          </div>
        )}

        {snapshot && snapshot.errors.length > 0 && (
          <p className="neg meta" style={{ marginBottom: 12 }}>
            Sebagian feed gagal: {snapshot.errors.join(", ")}
          </p>
        )}

        <section>
          <h2>Kondisi 4 aset</h2>
          <div className="cards">
            {(snapshot?.assets || []).map((a) => {
              const chgCls = a.changePct > 0 ? "pos" : a.changePct < 0 ? "neg" : "muted";
              const rsiCls =
                a.tf1h.rsi14 != null && a.tf1h.rsi14 >= 70
                  ? "neg"
                  : a.tf1h.rsi14 != null && a.tf1h.rsi14 <= 30
                    ? "pos"
                    : "";
              return (
                <article className="asset-card" key={a.symbol}>
                  <div className="card-top">
                    <div>
                      <span className="sym">{a.symbol}</span>
                      <span className="asset-name">{a.name}</span>
                    </div>
                    <div className="price-col">
                      <span className="price">{fmt(a.price, a.digits)}</span>
                      <span className={`chg ${chgCls}`}>
                        {a.changePct >= 0 ? "+" : ""}
                        {a.changePct.toFixed(2)}%
                      </span>
                    </div>
                  </div>

                  <div className="tf-grid">
                    <div>
                      <span className="lbl">15m</span>
                      <span className={`val ${biasClass(a.tf15m.bias)}`}>{a.tf15m.bias}</span>
                    </div>
                    <div>
                      <span className="lbl">1H</span>
                      <span className={`val ${biasClass(a.tf1h.bias)}`}>{a.tf1h.bias}</span>
                    </div>
                    <div>
                      <span className="lbl">4H</span>
                      <span className={`val ${biasClass(a.tf4h.bias)}`}>{a.tf4h.bias}</span>
                    </div>
                  </div>

                  <div className="metrics-grid">
                    <div>
                      <span className="lbl">RSI 1H</span>
                      <span className={`num ${rsiCls}`}>{a.tf1h.rsi14 ?? "—"}</span>
                    </div>
                    <div>
                      <span className="lbl">ADX 1H</span>
                      <span className="num">{a.tf1h.adx14 ?? "—"}</span>
                    </div>
                    <div>
                      <span className="lbl">S1</span>
                      <span className="num">{fmt(a.pivots.S1, a.digits)}</span>
                    </div>
                    <div>
                      <span className="lbl">R1</span>
                      <span className="num">{fmt(a.pivots.R1, a.digits)}</span>
                    </div>
                    <div>
                      <span className="lbl">ATR 1H</span>
                      <span className="num">{fmt(a.tf1h.atr14, a.digits)}</span>
                    </div>
                  </div>

                  <details>
                    <summary>Level pivot &amp; EMA</summary>
                    <dl className="kv-list">
                      <div>
                        <dt>Pivot (P)</dt>
                        <dd className="num">{fmt(a.pivots.P, a.digits)}</dd>
                      </div>
                      <div>
                        <dt>S2 / R2</dt>
                        <dd className="num">
                          {fmt(a.pivots.S2, a.digits)} / {fmt(a.pivots.R2, a.digits)}
                        </dd>
                      </div>
                      <div>
                        <dt>High / Low hari ini</dt>
                        <dd className="num">
                          {fmt(a.todayHigh, a.digits)} / {fmt(a.todayLow, a.digits)}
                        </dd>
                      </div>
                      <div>
                        <dt>1H Sup / Res (20)</dt>
                        <dd className="num">
                          {fmt(a.intradaySup1h, a.digits)} / {fmt(a.intradayRes1h, a.digits)}
                        </dd>
                      </div>
                      <div>
                        <dt>1H EMA20 / EMA50</dt>
                        <dd className="num">
                          {fmt(a.tf1h.ema20, a.digits)} / {fmt(a.tf1h.ema50, a.digits)}
                        </dd>
                      </div>
                      <div>
                        <dt>1D SMA200</dt>
                        <dd className="num">{fmt(a.sma200_1d, a.digits)}</dd>
                      </div>
                      <div>
                        <dt>Sumber</dt>
                        <dd>{a.source}</dd>
                      </div>
                    </dl>
                  </details>
                </article>
              );
            })}
          </div>
        </section>
      </main>

      <AssistantWidget />
    </>
  );
}
