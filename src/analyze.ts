// 분석 배치 (명세 Phase 3). SQLite의 스냅샷·holdings로 리스크·무결성·교차검증을 계산해
// data/analysis.json 에 기록. 정적 대시보드(Phase 4)가 이 JSON을 소비한다.
//
// 사용: npm run analyze
import Database from "better-sqlite3";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { Holding } from "./types.js";
import { loadOffchainSources } from "./collect_holdings.js";
import { loadBenchmarkConfig, tenorForWam } from "./collect_benchmark.js";
import { loadAssetClasses } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DB_PATH = resolve(ROOT, "data/poa.sqlite");
const OUT_PATH = resolve(ROOT, "data/analysis.json");

// ─────────────────────────── 순수 분석 함수 (단위 테스트 대상) ───────────────────────────

const DAY_MS = 86_400_000;

/** maturity까지 남은 일수 (기준일 refIso 대비). 음수면 이미 만기. */
export function daysToMaturity(maturityIso: string, refIso: string): number | null {
  const m = Date.parse(maturityIso);
  const r = Date.parse(refIso);
  if (Number.isNaN(m) || Number.isNaN(r)) return null;
  return Math.round((m - r) / DAY_MS);
}

/** 가중평균만기(WAM, 일). weight_pct 가중. 기준일 refIso. */
export function weightedAvgMaturity(holdings: Holding[], refIso: string): number | null {
  let wsum = 0;
  let acc = 0;
  for (const h of holdings) {
    if (!h.maturity_date || h.weight_pct == null) continue;
    const d = daysToMaturity(h.maturity_date, refIso);
    if (d == null) continue;
    wsum += h.weight_pct;
    acc += h.weight_pct * d;
  }
  return wsum > 0 ? acc / wsum : null;
}

export const MATURITY_BUCKETS = [
  { key: "0-1m", maxDays: 30 },
  { key: "1-3m", maxDays: 90 },
  { key: "3-6m", maxDays: 180 },
  { key: "6-12m", maxDays: 365 },
  { key: "12m+", maxDays: Infinity },
] as const;

/** 만기 버킷별 비중(%) 분포. */
export function maturityBuckets(
  holdings: Holding[],
  refIso: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of MATURITY_BUCKETS) out[b.key] = 0;
  for (const h of holdings) {
    if (!h.maturity_date) continue;
    const d = daysToMaturity(h.maturity_date, refIso);
    if (d == null) continue;
    const bucket = MATURITY_BUCKETS.find((b) => d <= b.maxDays) ?? MATURITY_BUCKETS[MATURITY_BUCKETS.length - 1];
    out[bucket.key] += h.weight_pct ?? 0;
  }
  return round2(out);
}

/** 자산유형별 집중도(비중 % 합). */
export function typeConcentration(holdings: Holding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of holdings) {
    const t = h.instrument_type || "unknown";
    out[t] = (out[t] ?? 0) + (h.weight_pct ?? 0);
  }
  return round2(out);
}

export interface NavPoint {
  observed_date: string;
  nav: number | null;
  yield_pct: number | null;
}

export interface TrackRecord {
  n_obs: number;
  first_date: string;
  last_date: string;
  span_days: number;
  total_return_pct: number | null;
  annualized_return_pct: number | null;
  volatility_pct: number | null; // 일일수익률 연율화 표준편차
  max_drawdown_pct: number | null; // 최대 낙폭(음수)
  uptime: number | null; // 관측일 / 기간일 (0~1)
  latest_yield_pct: number | null;
}

/** NAV 시계열 → track record 지표 (순수, 테스트 대상). */
export function computeTrackRecord(points: NavPoint[]): TrackRecord | null {
  const pts = points
    .filter((p) => p.nav != null && Number.isFinite(p.nav) && (p.nav as number) > 0)
    .sort((a, b) => a.observed_date.localeCompare(b.observed_date));
  if (pts.length < 2) return null;

  const navs = pts.map((p) => p.nav as number);
  const first = navs[0];
  const last = navs[navs.length - 1];
  const firstDate = pts[0].observed_date;
  const lastDate = pts[pts.length - 1].observed_date;
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(lastDate) - Date.parse(firstDate)) / 86_400_000),
  );

  const totalReturn = first > 0 ? (last / first - 1) * 100 : null;
  const annualized =
    first > 0 && spanDays > 0
      ? (Math.pow(last / first, 365 / spanDays) - 1) * 100
      : null;

  // 일일수익률 변동성 (연율화)
  const rets: number[] = [];
  for (let i = 1; i < navs.length; i++) {
    if (navs[i - 1] > 0) rets.push(navs[i] / navs[i - 1] - 1);
  }
  let volatility: number | null = null;
  if (rets.length >= 2) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    volatility = Math.sqrt(varc) * Math.sqrt(252) * 100;
  }

  // 최대 낙폭
  let peak = navs[0];
  let maxDd = 0;
  for (const n of navs) {
    if (n > peak) peak = n;
    const dd = peak > 0 ? (n - peak) / peak : 0;
    if (dd < maxDd) maxDd = dd;
  }

  const uptime = Math.min(1, pts.length / (spanDays + 1));
  const latestYield = pts[pts.length - 1].yield_pct;

  return {
    n_obs: pts.length,
    first_date: firstDate,
    last_date: lastDate,
    span_days: spanDays,
    total_return_pct: totalReturn == null ? null : round4(totalReturn),
    annualized_return_pct: annualized == null ? null : round4(annualized),
    volatility_pct: volatility == null ? null : round4(volatility),
    max_drawdown_pct: round4(maxDd * 100),
    uptime: round4(uptime),
    latest_yield_pct: latestYield,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export type ReliabilityGrade = "high" | "medium" | "low";

/**
 * 오라클 신뢰도 스코어 (0-100) — 투명한 감점식. 약점(낮은 bar 등)을 숨기지 않고 flags로 노출.
 *  freshness: stale −30, expired −60
 *  quorum(bar): 불명 −15, <3 약함 −20, 3~12 −5, ≥13 감점 없음
 *  교차체인 발산 −20
 */
export function computeReliability(
  freshness: string,
  quorum: number | null,
  validatorCount: number | null,
  crossChainDivergent: boolean,
  uptime: number | null = null,
): { score: number; grade: ReliabilityGrade; flags: string[] } {
  let score = 100;
  const flags: string[] = [];
  if (freshness === "stale") {
    score -= 30;
    flags.push("데이터 stale (>26h)");
  } else if (freshness === "expired") {
    score -= 60;
    flags.push("데이터 expired (>72h) — 갱신 중단");
  }
  // 가동률(track record 있을 때만): 관측 규칙성이 낮으면 감점
  if (uptime != null && uptime < 0.8) {
    score -= 10;
    flags.push(`가동률 낮음 (${Math.round(uptime * 100)}%)`);
  }
  if (quorum == null) {
    score -= 15;
    flags.push("쿼럼 불명");
  } else if (quorum < 3) {
    score -= 20;
    flags.push(`attestation 약함 (쿼럼 ${quorum}${validatorCount ? `/${validatorCount}` : ""})`);
  } else if (quorum < 13) {
    score -= 5;
  }
  if (crossChainDivergent) {
    score -= 20;
    flags.push("교차체인 NAV 발산");
  }
  score = Math.max(0, score);
  const grade: ReliabilityGrade = score >= 75 ? "high" : score >= 40 ? "medium" : "low";
  return { score, grade, flags };
}

/** 교차체인 NAV 발산율(%): (max-min)/min * 100. */
export function navDivergencePct(navs: number[]): number {
  const valid = navs.filter((n) => Number.isFinite(n) && n > 0);
  if (valid.length < 2) return 0;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return ((max - min) / min) * 100;
}

function round2(o: Record<string, number>): Record<string, number> {
  const r: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) r[k] = Math.round(v * 100) / 100;
  return r;
}

// ─────────────────────────── DB 로딩 + 오케스트레이션 ───────────────────────────

interface SnapRow {
  oracle_id: string;
  issuer: string;
  asset_ticker: string;
  chain: string;
  observed_at: string;
  nav: number | null;
  freshness: string;
  trust_grade: string;
  custody_status: string;
  quorum: number | null;
  validator_count: number | null;
  feed_name: string | null;
  source_address: string | null;
  consumer_address: string | null;
}

/**
 * 토큰 yield(%)와 벤치마크 금리(%)로 스프레드(bps) + 자산군별 해석.
 * 국채: 스프레드=토큰화·운용 비용. 크레딧/CLO: 스프레드=신용위험 프리미엄(양수 정상).
 * 주식: 국채 벤치마크 부적합(자본이득형).
 */
export function computeSpread(
  yieldPct: number,
  benchmarkPct: number,
  assetClass: string = "unknown",
): { spread_bps: number; verdict: string } {
  const bps = Math.round((yieldPct - benchmarkPct) * 100);
  let verdict: string;
  if (assetClass === "clo" || assetClass === "credit") {
    if (bps < -10) verdict = "국채보다 낮음 — 크레딧인데 이례적, 점검 필요";
    else verdict = `신용 스프레드 +${bps}bp — 신용위험 대비 보상 (프리미엄 적정성 판단)`;
  } else if (assetClass === "equity") {
    verdict = "국채 벤치마크 부적합 — 자본이득형(주식), yield 비교 무의미";
  } else {
    // treasury / unknown
    if (bps < -10) verdict = "국채 대비 낮음 — 직접 국채가 유리 (운용보수·토큰화 비용)";
    else if (bps <= 10) verdict = "국채와 유사 — 토큰화 편의값 수준";
    else verdict = "국채 대비 높음 — 초과수익, 리스크 요인 점검 필요";
  }
  return { spread_bps: bps, verdict };
}

// 체인별 블록 익스플로러 (주소 출처를 사람이 검증할 수 있게)
const EXPLORER: Record<string, string> = {
  ethereum: "https://etherscan.io/address/",
  base: "https://basescan.org/address/",
  monad: "https://explorer.monad.xyz/address/",
};

function explorerUrl(chain: string, addr: string | null): string | null {
  if (!addr) return null;
  const base = EXPLORER[chain];
  return base ? base + addr : null;
}

/** 오라클별 최신 스냅샷(observed_at 최대) 1행. */
function latestSnapshots(db: Database.Database): SnapRow[] {
  return db
    .prepare(
      `SELECT s.* FROM snapshots s
       JOIN (SELECT oracle_id, MAX(observed_at) mo FROM snapshots GROUP BY oracle_id) m
         ON s.oracle_id = m.oracle_id AND s.observed_at = m.mo`,
    )
    .all() as SnapRow[];
}

function holdingsFor(db: Database.Database, oracleId: string): { rows: Holding[]; asOf: string } {
  // 가장 최근 as_of(observed_at)의 holdings
  const latest = db
    .prepare(`SELECT MAX(observed_at) mo FROM holdings WHERE oracle_id=?`)
    .get(oracleId) as { mo: string | null };
  if (!latest?.mo) return { rows: [], asOf: "" };
  const rows = db
    .prepare(
      `SELECT instrument_type, identifier, units, price, market_value, maturity_date, weight_pct
       FROM holdings WHERE oracle_id=? AND observed_at=?`,
    )
    .all(oracleId, latest.mo) as Holding[];
  return { rows, asOf: latest.mo };
}

function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`DB 없음: ${DB_PATH} — 먼저 npm run collect 하세요.`);
    process.exit(1);
  }
  const nowIso = new Date().toISOString();
  const db = new Database(DB_PATH, { readonly: true });
  const snaps = latestSnapshots(db);

  // 오프체인 소스 정의 (source 태그 → url 매핑, holdings 출처용)
  const offchain = loadOffchainSources();
  const offchainByOracle = new Map(offchain.map((s) => [s.oracle_id, s]));

  // 오라클별 최신 yield (yields 테이블)
  const yieldRows = db
    .prepare(
      `SELECT y.oracle_id, y.yield_pct, y.as_of, y.source FROM yields y
       JOIN (SELECT oracle_id, MAX(as_of) mo FROM yields GROUP BY oracle_id) m
         ON y.oracle_id=m.oracle_id AND y.as_of=m.mo`,
    )
    .all() as { oracle_id: string; yield_pct: number; as_of: string; source: string }[];
  const yieldByOracle = new Map(yieldRows.map((y) => [y.oracle_id, y]));

  // 자산군 태그
  const assetClasses = loadAssetClasses();

  // 오라클별 NAV 이력 → track record
  const histRows = db
    .prepare(`SELECT oracle_id, observed_date, nav, yield_pct FROM nav_history ORDER BY oracle_id, observed_date`)
    .all() as { oracle_id: string; observed_date: string; nav: number | null; yield_pct: number | null }[];
  const histByOracle = new Map<string, { observed_date: string; nav: number | null; yield_pct: number | null }[]>();
  for (const r of histRows) {
    const arr = histByOracle.get(r.oracle_id) ?? [];
    arr.push(r);
    histByOracle.set(r.oracle_id, arr);
  }
  const trackByOracle = new Map<string, ReturnType<typeof computeTrackRecord>>();
  for (const [oid, pts] of histByOracle) trackByOracle.set(oid, computeTrackRecord(pts));

  // 1) 자산별 밸류에이션 + 리스크 분해 (+ 항목별 출처)
  const assets = snaps.map((s) => {
    const { rows: holdings, asOf } = holdingsFor(db, s.oracle_id);
    const ref = asOf || s.observed_at || nowIso;
    const oc = offchainByOracle.get(s.oracle_id);
    return {
      oracle_id: s.oracle_id,
      ticker: s.asset_ticker,
      issuer: s.issuer,
      chain: s.chain,
      asset_class: assetClasses.get(s.oracle_id) ?? "unknown",
      nav: s.nav,
      yield_7d: yieldByOracle.get(s.oracle_id)?.yield_pct ?? null,
      freshness: s.freshness,
      trust_grade: s.trust_grade,
      custody_status: s.custody_status,
      attestation: { quorum: s.quorum, validator_count: s.validator_count, feed_name: s.feed_name },
      holdings_count: holdings.length,
      holdings_as_of: asOf || null,
      wam_days: holdings.length ? weightedAvgMaturity(holdings, ref) : null,
      maturity_buckets: holdings.length ? maturityBuckets(holdings, ref) : null,
      type_concentration: holdings.length ? typeConcentration(holdings) : null,
      track_record: trackByOracle.get(s.oracle_id) ?? null,
      // ── 출처 (provenance) ──
      source: {
        nav: {
          method: "onchain eth_call: latestRoundData()",
          chain: s.chain,
          address: s.source_address,
          explorer: explorerUrl(s.chain, s.source_address),
        },
        attestation: s.consumer_address
          ? {
              method: "onchain eth_call: barECDSA()/validatorsECDSA()/name()/latestPoke()",
              chain: s.chain,
              consumer_address: s.consumer_address,
              explorer: explorerUrl(s.chain, s.consumer_address),
            }
          : null,
        holdings:
          holdings.length && oc
            ? { method: `offchain ${oc.type}`, provider: oc.source, url: oc.url, as_of: asOf }
            : null,
      },
    };
  });

  // 2) 교차체인 NAV 검증 (같은 ticker가 여러 체인)
  const byTicker = new Map<string, SnapRow[]>();
  for (const s of snaps) {
    const arr = byTicker.get(s.asset_ticker) ?? [];
    arr.push(s);
    byTicker.set(s.asset_ticker, arr);
  }
  const cross_chain = [...byTicker.entries()]
    .filter(([, arr]) => arr.length > 1)
    .map(([ticker, arr]) => {
      const navs = arr.map((a) => a.nav ?? NaN);
      const div = navDivergencePct(navs.filter((n) => !Number.isNaN(n)));
      return {
        ticker,
        chains: arr.map((a) => a.chain),
        navs: arr.map((a) => a.nav),
        max_divergence_pct: Math.round(div * 1e4) / 1e4,
        flag: div > 0.5, // 0.5% 초과 발산 시 플래그
      };
    });

  // 3) look-through: 모든 holdings를 자산유형·만기버킷으로 합산 (현재 USTB만 기여)
  const allHoldings: { oracle_id: string; h: Holding; asOf: string }[] = [];
  for (const s of snaps) {
    const { rows, asOf } = holdingsFor(db, s.oracle_id);
    for (const h of rows) allHoldings.push({ oracle_id: s.oracle_id, h, asOf });
  }
  const ltByType: Record<string, number> = {};
  let ltTotalMv = 0;
  for (const { h } of allHoldings) {
    const t = h.instrument_type || "unknown";
    ltByType[t] = (ltByType[t] ?? 0) + (h.market_value ?? 0);
    ltTotalMv += h.market_value ?? 0;
  }
  const look_through = {
    total_market_value: Math.round(ltTotalMv),
    by_instrument_type: Object.fromEntries(
      Object.entries(ltByType).map(([k, v]) => [k, Math.round(v)]),
    ),
    source_oracles: [...new Set(allHoldings.map((a) => a.oracle_id))],
    holdings_total: allHoldings.length,
  };

  // 4) 무결성 게이트: freshness=expired 또는 trust_grade=C 또는 custody=failed
  const flagged = snaps
    .filter(
      (s) => s.freshness === "expired" || s.trust_grade === "C" || s.custody_status === "failed",
    )
    .map((s) => ({
      oracle_id: s.oracle_id,
      reason: s.freshness === "expired" ? "freshness=expired" : s.custody_status === "failed" ? "custody=failed" : "trust_grade=C",
      freshness: s.freshness,
      trust_grade: s.trust_grade,
    }));
  const crossFlagged = cross_chain.filter((c) => c.flag);
  const integrity_gate = {
    ok_count: snaps.length - flagged.length,
    flagged_count: flagged.length,
    flagged,
    cross_chain_divergence: crossFlagged,
  };

  // 4c) 오라클 신뢰도 스코어 (freshness·쿼럼·검증자·교차체인)
  const divergentTickers = new Set(
    cross_chain.filter((c) => c.flag).map((c) => c.ticker),
  );
  const oracle_reliability = snaps
    .map((s) => {
      const tr = trackByOracle.get(s.oracle_id);
      const r = computeReliability(
        s.freshness,
        s.quorum,
        s.validator_count,
        divergentTickers.has(s.asset_ticker),
        tr?.uptime ?? null,
      );
      return {
        oracle_id: s.oracle_id,
        ticker: s.asset_ticker,
        chain: s.chain,
        score: r.score,
        grade: r.grade,
        freshness: s.freshness,
        quorum: s.quorum,
        validator_count: s.validator_count,
        flags: r.flags,
      };
    })
    .sort((a, b) => a.score - b.score || a.oracle_id.localeCompare(b.oracle_id));

  // 5) 벤치마크 스프레드: 토큰 yield vs 위험자유금리(국채)
  const benchCfg = loadBenchmarkConfig();
  const curveRow = db
    .prepare(`SELECT observed_date FROM benchmarks ORDER BY observed_date DESC LIMIT 1`)
    .get() as { observed_date: string } | undefined;
  let benchmark: unknown = null;
  if (benchCfg && curveRow) {
    const rateRows = db
      .prepare(`SELECT tenor, rate_pct FROM benchmarks WHERE observed_date=?`)
      .all(curveRow.observed_date) as { tenor: string; rate_pct: number }[];
    const rates: Record<string, number> = {};
    for (const r of rateRows) rates[r.tenor] = r.rate_pct;

    const spreads = assets
      .filter((a) => a.yield_7d != null)
      .map((a) => {
        const tenor = tenorForWam(benchCfg, a.wam_days);
        const bench = rates[tenor];
        const s = bench != null ? computeSpread(a.yield_7d as number, bench, a.asset_class) : null;
        const yrow = yieldByOracle.get(a.oracle_id);
        return {
          oracle_id: a.oracle_id,
          ticker: a.ticker,
          asset_class: a.asset_class,
          token_yield_pct: a.yield_7d,
          yield_as_of: yrow?.as_of ?? null,
          yield_source: yrow?.source ?? null,
          is_manual: (yrow?.source ?? "").startsWith("manual"),
          benchmark_tenor: tenor,
          benchmark_pct: bench ?? null,
          spread_bps: s?.spread_bps ?? null,
          verdict: s?.verdict ?? null,
        };
      })
      .sort((x, y) => x.ticker.localeCompare(y.ticker));

    // 같은 티커(펀드)는 yield가 동일하므로 대표 1개만 (체인별 중복 제거)
    const seenTicker = new Set<string>();
    const dedupSpreads = spreads.filter((s) => {
      if (seenTicker.has(s.ticker)) return false;
      seenTicker.add(s.ticker);
      return true;
    });

    benchmark = {
      risk_free_curve: { as_of: curveRow.observed_date, source: "us-treasury", rates },
      note: "국채=스프레드는 토큰화·운용 비용. 크레딧/CLO=스프레드는 신용위험 프리미엄. CLO는 변동금리라 국채 벤치는 근사.",
      spreads: dedupSpreads,
    };
  }

  db.close();

  const analysis = {
    generated_at: nowIso,
    note: "attestation=전송 무결성이지 독립 회계감사 아님 (명세 부록 B)",
    // 데이터 출처 레지스트리 (감사 추적 — 명세 원칙 5)
    sources: {
      registry_addresses: {
        description: "오라클 adapter/router 주소",
        origin: "Chronicle 공식 문서 (2026-07 기준)",
        stored_in: "config/oracles.yaml",
        verification: "런타임에 온체인 decimals() 응답으로 검증 (scripts/verify_addresses.ts)",
      },
      onchain_nav: {
        description: "NAV·roundId·updatedAt",
        method: "eth_call latestRoundData()/decimals()",
        target: "Chronicle VAO Chainlink adapter 또는 router (자산별 주소는 각 asset.source.nav)",
        rpc: "무료 공용 RPC (config/rpc.yaml, 다중 fallback)",
        trust_boundary: "커스터디언 보고값의 온체인 전송 무결성. 독립 회계감사 아님.",
      },
      onchain_attestation: {
        description: "검증자 집합·쿼럼(bar)·피드명·latestPoke",
        method: "eth_call barECDSA()/validatorsECDSA()/name()/latestPoke()",
        target: "Chronicle VAO consumer (자산별 주소는 각 asset.source.attestation)",
      },
      offchain_holdings: offchain.map((o) => ({
        oracle_id: o.oracle_id,
        provider: o.source,
        url: o.url,
        type: o.type,
        note: "발행사 공개 데이터 — 온체인 read-only 경계 밖",
      })),
      benchmark: {
        risk_free: {
          description: "위험자유금리 (US Treasury par yield curve)",
          provider: "US Treasury",
          url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
          note: "무료·무인증 XML. 스프레드 = 토큰 yield − 국채금리",
        },
        token_yield: {
          description: "토큰 yield (자산별 소스)",
          config: "config/benchmarks.yaml",
        },
      },
    },
    asset_count: assets.length,
    assets,
    cross_chain,
    look_through,
    integrity_gate,
    oracle_reliability,
    benchmark,
  };

  if (!existsSync(dirname(OUT_PATH))) mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(analysis, null, 2));

  // 콘솔 요약
  console.log("=".repeat(72));
  console.log("분석 요약");
  console.log("=".repeat(72));
  for (const a of assets.filter((x) => x.holdings_count > 0)) {
    console.log(
      `  ${a.ticker} (${a.chain}): WAM=${a.wam_days?.toFixed(0)}d, holdings=${a.holdings_count}, 만기버킷=${JSON.stringify(a.maturity_buckets)}`,
    );
  }
  console.log(
    `\n  look-through 총 시장가치: $${look_through.total_market_value.toLocaleString()} (${look_through.holdings_total}건, ${look_through.source_oracles.length}개 오라클)`,
  );
  console.log(`  자산유형: ${JSON.stringify(look_through.by_instrument_type)}`);
  console.log(
    `\n  무결성 게이트: OK ${integrity_gate.ok_count} / 플래그 ${integrity_gate.flagged_count}`,
  );
  for (const f of flagged) console.log(`    ⚠️  ${f.oracle_id}: ${f.reason}`);
  if (crossFlagged.length) {
    for (const c of crossFlagged)
      console.log(`    ⚠️  ${c.ticker} 교차체인 발산 ${c.max_divergence_pct}%`);
  }
  const withTrack = assets.filter((a) => a.track_record);
  if (withTrack.length) {
    console.log("\n  track record (이력 보유):");
    for (const a of withTrack) {
      const t = a.track_record!;
      console.log(
        `    ${a.ticker.padEnd(10)} ${t.n_obs}일 [${t.first_date}~] 연율수익 ${t.annualized_return_pct?.toFixed(2)}% 변동성 ${t.volatility_pct?.toFixed(2)}% 최대낙폭 ${t.max_drawdown_pct?.toFixed(2)}% 가동률 ${Math.round((t.uptime ?? 0) * 100)}%`,
      );
    }
  }

  console.log("\n  오라클 신뢰도 (하위 5):");
  for (const r of oracle_reliability.slice(0, 5)) {
    console.log(
      `    ${r.ticker.padEnd(10)} ${r.chain.padEnd(9)} score=${r.score} (${r.grade})${r.flags.length ? " — " + r.flags.join(", ") : ""}`,
    );
  }

  if (benchmark && (benchmark as { spreads?: unknown[] }).spreads?.length) {
    const b = benchmark as {
      risk_free_curve: { as_of: string };
      spreads: { ticker: string; token_yield_pct: number; benchmark_tenor: string; benchmark_pct: number; spread_bps: number; verdict: string }[];
    };
    console.log(`\n  벤치마크 스프레드 (국채 as_of ${b.risk_free_curve.as_of}):`);
    for (const s of b.spreads) {
      const sign = s.spread_bps >= 0 ? "+" : "";
      console.log(
        `    ${s.ticker}: yield ${s.token_yield_pct?.toFixed(2)}% vs ${s.benchmark_tenor} 국채 ${s.benchmark_pct}% = ${sign}${s.spread_bps}bp — ${s.verdict}`,
      );
    }
  }

  console.log(`\n→ ${OUT_PATH.replace(ROOT + "/", "")} 기록됨`);
}

// 직접 실행일 때만 (import 시 실행 안 됨)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
