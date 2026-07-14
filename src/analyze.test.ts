// 단위 테스트: 분석 순수 함수 (WAM·만기버킷·집중도·발산·알림)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysToMaturity,
  weightedAvgMaturity,
  maturityBuckets,
  typeConcentration,
  navDivergencePct,
  computeSpread,
  computeReliability,
  computeTrackRecord,
} from "./analyze.js";
import {
  parseTreasuryXml,
  tenorForWam,
  type BenchmarkConfig,
} from "./collect_benchmark.js";
import { deriveAlerts } from "./alert.js";
import type { Holding } from "./types.js";

function h(over: Partial<Holding>): Holding {
  return {
    instrument_type: "treasury",
    identifier: null,
    units: null,
    price: null,
    market_value: 0,
    maturity_date: null,
    weight_pct: 0,
    ...over,
  };
}

test("daysToMaturity: 일수 계산", () => {
  assert.equal(daysToMaturity("2026-06-16", "2026-05-22"), 25);
  assert.equal(daysToMaturity("2026-05-01", "2026-05-22"), -21); // 이미 만기
  assert.equal(daysToMaturity("bad", "2026-05-22"), null);
});

test("weightedAvgMaturity: 비중 가중", () => {
  const holdings = [
    h({ maturity_date: "2026-06-21", weight_pct: 50 }), // 30d
    h({ maturity_date: "2026-07-21", weight_pct: 50 }), // 60d
  ];
  // (50*30 + 50*60)/100 = 45
  assert.equal(weightedAvgMaturity(holdings, "2026-05-22"), 45);
  assert.equal(weightedAvgMaturity([], "2026-05-22"), null);
});

test("maturityBuckets: 버킷 분포", () => {
  const holdings = [
    h({ maturity_date: "2026-06-10", weight_pct: 40 }), // 19d → 0-1m
    h({ maturity_date: "2026-07-15", weight_pct: 35 }), // 54d → 1-3m
    h({ maturity_date: "2026-12-01", weight_pct: 25 }), // ~193d → 6-12m
  ];
  const b = maturityBuckets(holdings, "2026-05-22");
  assert.equal(b["0-1m"], 40);
  assert.equal(b["1-3m"], 35);
  assert.equal(b["6-12m"], 25);
  assert.equal(b["12m+"], 0);
});

test("typeConcentration: 유형별 합", () => {
  const c = typeConcentration([
    h({ instrument_type: "treasury", weight_pct: 80 }),
    h({ instrument_type: "repo", weight_pct: 15 }),
    h({ instrument_type: "cash", weight_pct: 5 }),
  ]);
  assert.equal(c.treasury, 80);
  assert.equal(c.repo, 15);
  assert.equal(c.cash, 5);
});

test("navDivergencePct: 교차체인 발산율", () => {
  assert.equal(navDivergencePct([1.0, 1.0, 1.0]), 0);
  assert.equal(Math.round(navDivergencePct([1.0, 1.01]) * 100) / 100, 1); // 1%
  assert.equal(navDivergencePct([1.0]), 0); // 단일
});

test("computeSpread: bps + 자산군별 판정", () => {
  // treasury (기본)
  assert.equal(computeSpread(3.49, 3.71, "treasury").spread_bps, -22);
  assert.match(computeSpread(3.49, 3.71, "treasury").verdict, /직접 국채가 유리/);
  assert.match(computeSpread(3.80, 3.75, "treasury").verdict, /유사/);
  // credit/clo: 양수=신용 프리미엄
  assert.match(computeSpread(4.17, 3.85, "credit").verdict, /신용 스프레드/);
  assert.match(computeSpread(3.54, 3.85, "clo").verdict, /이례적/); // AAA CLO가 국채보다 낮음
  // equity: 국채 벤치 부적합
  assert.match(computeSpread(8.0, 3.85, "equity").verdict, /부적합/);
});

test("tenorForWam: WAM → 테너", () => {
  const cfg = {
    tenor_by_wam: [
      { max_days: 45, tenor: "m1" },
      { max_days: 135, tenor: "m3" },
      { max_days: 100000, tenor: "y1" },
    ],
    default_tenor: "m3",
  } as BenchmarkConfig;
  assert.equal(tenorForWam(cfg, 32), "m1");
  assert.equal(tenorForWam(cfg, 90), "m3");
  assert.equal(tenorForWam(cfg, 400), "y1");
  assert.equal(tenorForWam(cfg, null), "m3"); // default
});

test("parseTreasuryXml: 테너별 최신값 파싱", () => {
  const xml =
    '<feed><entry><content><m:properties>' +
    '<d:NEW_DATE>2026-07-09T00:00:00</d:NEW_DATE>' +
    '<d:BC_1MONTH>3.70</d:BC_1MONTH><d:BC_3MONTH>3.84</d:BC_3MONTH>' +
    '</m:properties></content></entry>' +
    '<entry><content><m:properties>' +
    '<d:NEW_DATE>2026-07-10T00:00:00</d:NEW_DATE>' +
    '<d:BC_1MONTH>3.71</d:BC_1MONTH><d:BC_3MONTH>3.85</d:BC_3MONTH>' +
    '</m:properties></content></entry></feed>';
  const c = parseTreasuryXml(xml, { m1: "BC_1MONTH", m3: "BC_3MONTH" });
  assert.equal(c.as_of, "2026-07-10");
  assert.equal(c.rates.m1, 3.71); // 마지막 관측
  assert.equal(c.rates.m3, 3.85);
});

test("computeTrackRecord: 수익률·낙폭·가동률", () => {
  // 100일간 1.00 → 1.03 (완만한 상승, 낙폭 없음)
  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    pts.push({ observed_date: d, nav: 1.0 + 0.0003 * i, yield_pct: 3.0 });
  }
  const t = computeTrackRecord(pts)!;
  assert.equal(t.n_obs, 101);
  assert.equal(t.span_days, 100);
  assert.ok(Math.abs(t.total_return_pct! - 3.0) < 0.01, `total ${t.total_return_pct}`);
  assert.ok(t.max_drawdown_pct === 0, `dd ${t.max_drawdown_pct}`); // 단조증가 → 낙폭 0
  assert.ok(t.uptime! > 0.99);
  // 데이터 1개면 null
  assert.equal(computeTrackRecord([{ observed_date: "2026-01-01", nav: 1, yield_pct: null }]), null);
});

test("computeTrackRecord: 낙폭 감지", () => {
  const pts = [
    { observed_date: "2026-01-01", nav: 1.0, yield_pct: null },
    { observed_date: "2026-01-02", nav: 1.1, yield_pct: null },
    { observed_date: "2026-01-03", nav: 0.99, yield_pct: null }, // peak 1.1 → 0.99
  ];
  const t = computeTrackRecord(pts)!;
  assert.ok(Math.abs(t.max_drawdown_pct! - -10) < 0.01, `dd ${t.max_drawdown_pct}`); // -10%
});

test("computeReliability: freshness·쿼럼·발산 감점 + 플래그", () => {
  // fresh + bar2(약함) → 80 high, 약함 플래그
  const a = computeReliability("fresh", 2, 25, false);
  assert.equal(a.score, 80);
  assert.equal(a.grade, "high");
  assert.match(a.flags.join(), /attestation 약함/);
  // stale + bar2 → 50 medium
  assert.equal(computeReliability("stale", 2, 25, false).score, 50);
  // expired + bar2 → 20 low
  const e = computeReliability("expired", 2, 25, false);
  assert.equal(e.score, 20);
  assert.equal(e.grade, "low");
  // 강한 bar + fresh + 발산 → 100-0-20=80
  assert.equal(computeReliability("fresh", 13, 25, true).score, 80);
});

test("deriveAlerts: 무결성 위반 → 알림", () => {
  const alerts = deriveAlerts({
    generated_at: "2026-07-13T00:00:00Z",
    integrity_gate: {
      flagged: [
        { oracle_id: "securitize_stac_eth", reason: "freshness=expired" },
        { oracle_id: "x_eth", reason: "trust_grade=C" },
      ],
      cross_chain_divergence: [{ ticker: "deJAAA", max_divergence_pct: 0.8 }],
    },
  });
  assert.equal(alerts.length, 3);
  assert.equal(alerts[0].severity, "critical"); // expired
  assert.equal(alerts[1].severity, "warn"); // grade C
  assert.equal(alerts[2].severity, "warn"); // divergence
});
