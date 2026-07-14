// 단위 테스트: 정규화(스케일링·freshness·grade) + 저장 멱등 (명세 6장)
// 실행: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaleAnswer,
  computeFreshness,
  computeTrustGrade,
  normalizeOne,
} from "./normalize.js";
import { JsonStore } from "./store_json.js";
import { SqliteStore } from "./store_sqlite.js";
import { mapHoldings } from "./collect_holdings.js";
import type { AssetSnapshot } from "./types.js";
import type { RawTier1 } from "./collect_tier1.js";
import type { OracleEntry } from "./registry.js";

// --- scaleAnswer ---
test("scaleAnswer: 18 decimals NAV 스케일링", () => {
  // 1.02 * 1e18
  assert.equal(scaleAnswer(1_020_000_000_000_000_000n, 18), 1.02);
  assert.equal(scaleAnswer(10n ** 18n, 18), 1.0);
});

test("scaleAnswer: 큰 값도 정밀 (raw int256)", () => {
  // 1020.6 * 1e18 (STAC 유사)
  const v = scaleAnswer(1_020_600_000_000_000_000_000n, 18);
  assert.ok(Math.abs(v - 1020.6) < 1e-9, `got ${v}`);
});

// --- freshness ---
test("computeFreshness: 경계값", () => {
  const now = 1_000 * 3600_000; // 임의 기준(ms)
  const hAgo = (h: number) => now - h * 3600_000;
  assert.equal(computeFreshness(hAgo(1), now, 26, 72), "fresh");
  assert.equal(computeFreshness(hAgo(26), now, 26, 72), "fresh"); // ≤26h
  assert.equal(computeFreshness(hAgo(48), now, 26, 72), "stale");
  assert.equal(computeFreshness(hAgo(72), now, 26, 72), "stale"); // ≤72h
  assert.equal(computeFreshness(hAgo(100), now, 26, 72), "expired");
});

// --- trust_grade ---
test("computeTrustGrade: 규칙", () => {
  assert.equal(computeTrustGrade("fresh", 10n ** 18n), "A");
  assert.equal(computeTrustGrade("stale", 10n ** 18n), "B");
  assert.equal(computeTrustGrade("expired", 10n ** 18n), "C");
  assert.equal(computeTrustGrade("fresh", 0n), "C"); // 값 이상
  assert.equal(computeTrustGrade("fresh", -5n), "C"); // 음수
});

// --- normalizeOne 통합 ---
function fakeRaw(over: Partial<RawTier1> = {}): RawTier1 {
  const entry: OracleEntry = {
    id: "test_x_eth",
    issuer: "Test",
    asset_ticker: "X",
    chain: "ethereum",
    adapter_address: "0x0000000000000000000000000000000000000001",
    router_address: null,
    read_address: "0x0000000000000000000000000000000000000001",
  };
  return {
    entry,
    ok: true,
    roundId: 42n,
    answer: 10n ** 18n,
    startedAt: 0n,
    updatedAt: 1000n,
    answeredInRound: 42n,
    decimals: 18,
    ...over,
  };
}

test("normalizeOne: round_id 문자열, nav 스케일, grade 계산", () => {
  const observedSec = 2_000_000n;
  const nowMs = Number(observedSec) * 1000 + 3600_000; // 1시간 뒤
  const s = normalizeOne(fakeRaw({ updatedAt: observedSec, answer: 10n ** 18n }), nowMs);
  assert.equal(s.round_id, "42");
  assert.equal(s.nav, 1.0);
  assert.equal(s.raw_answer, (10n ** 18n).toString());
  assert.equal(s.freshness, "fresh");
  assert.equal(s.trust_grade, "A");
  assert.equal(s.holdings.length, 0);
  assert.equal(s.attestation, null); // 기본값
});

test("normalizeOne: attestation 전달 시 스냅샷에 포함", () => {
  const nowMs = 2_000_000 * 1000 + 3600_000;
  const att = {
    consumer_address: "0x0000000000000000000000000000000000000002",
    feed_name: "VAO::Test",
    wat: null,
    quorum: 2,
    validator_count: 25,
    validators: ["0x0000000000000000000000000000000000000003"],
    latest_poke: "2026-07-11T00:00:00.000Z",
  };
  const s = normalizeOne(fakeRaw({ updatedAt: 2_000_000n }), nowMs, att);
  assert.equal(s.attestation?.feed_name, "VAO::Test");
  assert.equal(s.attestation?.quorum, 2);
  assert.equal(s.attestation?.validator_count, 25);
});

// --- 저장 멱등 ---
function fakeSnapshot(round: string): AssetSnapshot {
  return {
    oracle_id: "test_x_eth",
    issuer: "Test",
    asset_ticker: "X",
    chain: "ethereum",
    round_id: round,
    observed_at: "2026-07-13T00:00:00.000Z",
    ingested_at: "2026-07-13T00:00:00.000Z",
    nav: 1.0,
    raw_answer: "1000000000000000000",
    decimals: 18,
    aum: null,
    yield_7d: null,
    holdings: [],
    custody_status: "unknown",
    freshness: "fresh",
    trust_grade: "A",
    source_address: "0x0000000000000000000000000000000000000001",
    attestation: null,
  };
}

test("JsonStore: (oracle_id, round_id) 멱등 — 2번 저장해도 중복 없음", async () => {
  const dir = mkdtempSync(join(tmpdir(), "poa-store-"));
  try {
    const store = new JsonStore(dir);
    const r1 = await store.append([fakeSnapshot("1"), fakeSnapshot("2")]);
    assert.equal(r1.appended, 2);
    assert.equal(r1.skipped, 0);

    // 동일 데이터 재저장 → 전부 스킵
    const r2 = await store.append([fakeSnapshot("1"), fakeSnapshot("2")]);
    assert.equal(r2.appended, 0);
    assert.equal(r2.skipped, 2);

    // 새 라운드 하나만 추가
    const r3 = await store.append([fakeSnapshot("2"), fakeSnapshot("3")]);
    assert.equal(r3.appended, 1);
    assert.equal(r3.skipped, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 오프체인 holdings 매핑 (USTB 실제 응답 형태) ---
test("mapHoldings: money/percent/date 파서 + const", () => {
  const rows = [
    {
      "Security Name": "U.S. Treasury Bill 05/26/2026",
      "Base Value/Cost": "$31,487,838",
      Maturity: "26-May-2026",
      "Current Yld": "3.53%",
      "% of Fund": "3.22%",
    },
  ];
  const fields = {
    instrument_type: { const: "treasury" },
    identifier: { path: "Security Name", parse: "str" as const },
    maturity_date: { path: "Maturity", parse: "date_dmy" as const },
    market_value: { path: "Base Value/Cost", parse: "money" as const },
    weight_pct: { path: "% of Fund", parse: "percent" as const },
    units: { const: null },
    price: { const: null },
  };
  const [h] = mapHoldings(rows, fields);
  assert.equal(h.instrument_type, "treasury");
  assert.equal(h.identifier, "U.S. Treasury Bill 05/26/2026");
  assert.equal(h.maturity_date, "2026-05-26");
  assert.equal(h.market_value, 31_487_838);
  assert.equal(h.weight_pct, 3.22);
  assert.equal(h.units, null);
});

test("SqliteStore: 멱등 저장 + attestation/validator 기록", async () => {
  const dir = mkdtempSync(join(tmpdir(), "poa-sqlite-"));
  try {
    const store = new SqliteStore(join(dir, "test.sqlite"));
    const snap: AssetSnapshot = {
      ...fakeSnapshot("1"),
      attestation: {
        consumer_address: "0x0000000000000000000000000000000000000002",
        feed_name: "VAO::Test",
        wat: null,
        quorum: 2,
        validator_count: 2,
        validators: [
          "0x0000000000000000000000000000000000000003",
          "0x0000000000000000000000000000000000000004",
        ],
        latest_poke: "2026-07-11T00:00:00.000Z",
      },
    };
    const r1 = await store.append([snap]);
    assert.equal(r1.appended, 1);
    assert.equal(r1.skipped, 0);

    // 재저장 → 스킵
    const r2 = await store.append([snap]);
    assert.equal(r2.appended, 0);
    assert.equal(r2.skipped, 1);

    // holdings upsert 멱등
    const h = {
      instrument_type: "treasury",
      identifier: "912797KL5",
      units: 100,
      price: 99.8,
      market_value: 9980,
      maturity_date: "2026-09-01",
      weight_pct: 50,
    };
    const hr1 = store.upsertHoldings("test_x_eth", snap.observed_at, [h], "test-src");
    assert.equal(hr1.inserted, 1);
    const hr2 = store.upsertHoldings("test_x_eth", snap.observed_at, [h], "test-src");
    assert.equal(hr2.inserted, 0); // 멱등
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
