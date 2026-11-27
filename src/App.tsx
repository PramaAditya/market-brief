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

interface BiasDisplay {
  direction: "up" | "down" | "flat";
  label: string;
  note?: string;
  cls: string;
  pillCls: string;
}

function parseBias(bias: string): BiasDisplay {
  const low = bias.toLowerCase();
  if (low.includes("bull")) {
    return {
      direction: "up",
      label: "Naik",
      note: low.includes("pullback") ? "turun sebentar (pullback)" : undefined,
      cls: "pos",
      pillCls: "tf-pill tf-up",
    };
  }
  if (low.includes("bear")) {
    return {
      direction: "down",
      label: "Turun",
      note: low.includes("bounce") ? "naik sebentar (bounce)" : undefined,
      cls: "neg",
      pillCls: "tf-pill tf-down",
    };
  }
  return {
    direction: "flat",
    label: "Datar",
    cls: "muted",
    pillCls: "tf-pill tf-flat",
  };
}

function TrendIcon({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up") {
    return (
      <svg
        className="tf-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 17 17 7" />
        <path d="M8 7h9v9" />
      </svg>
    );
  }
  if (direction === "down") {
    return (
      <svg
        className="tf-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 7 17 17" />
        <path d="M17 8v9H8" />
      </svg>
    );
  }
  return (
    <svg
      className="tf-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m14 7 5 5-5 5" />
    </svg>
  );
}

function describeMomentum(rsi: number | null): { text: string; cls: string } {
  if (rsi == null || Number.isNaN(rsi)) return { text: "Belum ada data", cls: "muted" };
  const n = Math.round(rsi);
  if (rsi >= 70) return { text: `Jenuh beli (${n})`, cls: "neg" };
  if (rsi <= 30) return { text: `Jenuh jual (${n})`, cls: "pos" };
  if (rsi >= 58) return { text: `Cenderung kuat (${n})`, cls: "pos" };
  if (rsi <= 42) return { text: `Cenderung lemah (${n})`, cls: "neg" };
  return { text: `Netral (${n})`, cls: "" };
}

function describeTrendStrength(adx: number | null): { text: string; cls: string } {
  if (adx == null || Number.isNaN(adx)) return { text: "Belum ada data", cls: "muted" };
  const n = Math.round(adx);
  if (adx >= 25) return { text: `Kuat (${n})`, cls: "" };
  if (adx >= 18) return { text: `Sedang (${n})`, cls: "" };
  return { text: `Lemah / datar (${n})`, cls: "muted" };
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
          <h2>Arah tren 4 aset</h2>
          <div className="cards">
            {(snapshot?.assets || []).map((a) => {
              const chgCls = a.changePct > 0 ? "pos" : a.changePct < 0 ? "neg" : "muted";
              const t15 = parseBias(a.tf15m.bias);
              const t1h = parseBias(a.tf1h.bias);
              const t4h = parseBias(a.tf4h.bias);
              const momentum = describeMomentum(a.tf1h.rsi14);
              const strength = describeTrendStrength(a.tf1h.adx14);

              return (
                <article className="asset-card" key={a.symbol}>
                  <div className="card-head">
                    <span className="asset-title">{a.name}</span>
                    <span className="sym-muted">{a.symbol}</span>
                  </div>

                  <div className="tf-hero" aria-label="Arah tren per rentang waktu">
                    {[
                      { label: "15 menit", info: t15 },
                      { label: "1 jam", info: t1h },
                      { label: "4 jam", info: t4h },
                    ].map((item) => (
                      <div className={item.info.pillCls} key={item.label}>
                        <span className="tf-time">{item.label}</span>
                        <div className={`tf-main ${item.info.cls}`}>
                          <TrendIcon direction={item.info.direction} />
                          <span>{item.info.label}</span>
                        </div>
                        {item.info.note && <span className="tf-note">{item.info.note}</span>}
                      </div>
                    ))}
                  </div>

                  <div className="plain-metrics">
                    <div className="metric-item">
                      <span className="lbl">Momentum (RSI)</span>
                      <span className={`val ${momentum.cls}`}>{momentum.text}</span>
                    </div>
                    <div className="metric-item">
                      <span className="lbl">Kekuatan tren (ADX)</span>
                      <span className={`val ${strength.cls}`}>{strength.text}</span>
                    </div>
                    <div className="metric-item">
                      <span className="lbl">Support terdekat (S1)</span>
                      <span className="num">{fmt(a.pivots.S1, a.digits)}</span>
                    </div>
                    <div className="metric-item">
                      <span className="lbl">Resistance terdekat (R1)</span>
                      <span className="num">{fmt(a.pivots.R1, a.digits)}</span>
                    </div>
                  </div>

                  <div className="price-foot">
                    <span className="lbl-inline">Harga sekarang</span>
                    <div className="price-foot-val">
                      <span className="num-foot">{fmt(a.price, a.digits)}</span>
                      <span className={`chg ${chgCls}`}>
                        ({a.changePct >= 0 ? "+" : ""}
                        {a.changePct.toFixed(2)}%)
                      </span>
                    </div>
                  </div>

                  <details>
                    <summary>Detail level lainnya</summary>
                    <dl className="kv-list">
                      <div>
                        <dt>Rentang gerak per jam (ATR)</dt>
                        <dd className="num">±{fmt(a.tf1h.atr14, a.digits)}</dd>
                      </div>
                      <div>
                        <dt>Titik tengah harian (Pivot)</dt>
                        <dd className="num">{fmt(a.pivots.P, a.digits)}</dd>
                      </div>
                      <div>
                        <dt>Support / Resistance ke-2 (S2 / R2)</dt>
                        <dd className="num">
                          {fmt(a.pivots.S2, a.digits)} / {fmt(a.pivots.R2, a.digits)}
                        </dd>
                      </div>
                      <div>
                        <dt>Tertinggi / Terendah hari ini (High / Low)</dt>
                        <dd className="num">
                          {fmt(a.todayHigh, a.digits)} / {fmt(a.todayLow, a.digits)}
                        </dd>
                      </div>
                      <div>
                        <dt>Batas bawah / atas 1 jam (Support / Resistance)</dt>
                        <dd className="num">
                          {fmt(a.intradaySup1h, a.digits)} / {fmt(a.intradayRes1h, a.digits)}
                        </dd>
                      </div>
                      <div>
                        <dt>Rata-rata 20 / 50 jam (EMA 20 / 50)</dt>
                        <dd className="num">
                          {fmt(a.tf1h.ema20, a.digits)} / {fmt(a.tf1h.ema50, a.digits)}
                        </dd>
                      </div>
                      <div>
                        <dt>Rata-rata 200 hari (SMA 200)</dt>
                        <dd className="num">{fmt(a.sma200_1d, a.digits)}</dd>
                      </div>
                      <div>
                        <dt>Sumber data</dt>
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
