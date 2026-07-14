// 파이프라인 오케스트레이션 (명세 Phase 1, 태스크 5): collect → normalize → store
// 사용: npm run collect
import { loadRegistry } from "./registry.js";
import { collectTier1 } from "./collect_tier1.js";
import { collectAttestation } from "./collect_attestation.js";
import { normalizeOne } from "./normalize.js";
import { JsonStore } from "./store_json.js";
import { SqliteStore } from "./store_sqlite.js";
import { loadOffchainSources, fetchHoldings } from "./collect_holdings.js";
import {
  loadBenchmarkConfig,
  fetchYield,
  fetchTreasuryCurve,
} from "./collect_benchmark.js";
import type { AssetSnapshot } from "./types.js";

async function main() {
  const startedAt = Date.now();
  const registry = loadRegistry();
  console.log(`[collect] ${registry.length}개 오라클 Tier-1 수집 시작...`);

  // 1) collect
  const raw = await collectTier1(registry);

  // 벤치마크 설정 (자산별 yield 소스)
  const benchCfg = loadBenchmarkConfig();

  // 2) normalize (성공 read만 스냅샷으로; 실패는 로깅) + attestation + yield 수집(best-effort)
  const nowMs = Date.now();
  const snapshots: AssetSnapshot[] = [];
  const failures: { id: string; reason: string }[] = [];
  for (const r of raw) {
    if (r.ok) {
      const attestation = await collectAttestation(r.entry);
      snapshots.push(normalizeOne(r, nowMs, attestation));
    } else {
      failures.push({ id: r.entry.id, reason: r.reason });
    }
  }

  // 3) store (멱등) — JSON/CSV(대시보드) + SQLite(구조화 질의)
  const jsonStore = new JsonStore();
  const result = await jsonStore.append(snapshots);
  const sqlite = new SqliteStore();
  const sqlResult = await sqlite.append(snapshots);

  // 4) 오프체인 holdings (정의된 오라클만) → SQLite holdings 테이블
  const offchain = loadOffchainSources();
  const holdingsLog: string[] = [];
  for (const src of offchain) {
    try {
      const res = await fetchHoldings(src);
      const observedAt = res.as_of || nowIso(nowMs);
      const { inserted } = sqlite.upsertHoldings(
        res.oracle_id,
        observedAt,
        res.holdings,
        res.source,
      );
      holdingsLog.push(
        `  · ${res.oracle_id}: ${res.holdings.length}건 (신규 ${inserted}) as_of=${res.as_of || "?"} [${res.source}]`,
      );
    } catch (err) {
      holdingsLog.push(
        `  · ${src.oracle_id}: 실패 — ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`,
      );
    }
  }
  // 4b) 자산별 yield → yields 테이블
  const runDate = nowIso(nowMs);
  const yieldLog: string[] = [];
  const yieldByOracle = new Map<string, number>();
  for (const [oracleId, yspec] of Object.entries(benchCfg?.yields ?? {})) {
    const y = await fetchYield(yspec, runDate);
    if (y) {
      yieldByOracle.set(oracleId, y.pct);
      const { inserted } = sqlite.upsertYield(oracleId, y.as_of, y.pct, y.source);
      yieldLog.push(`  · ${oracleId}: ${y.pct.toFixed(2)}% as_of=${y.as_of} (신규 ${inserted}) [${y.source}]`);
    } else {
      yieldLog.push(`  · ${oracleId}: yield 수집 실패`);
    }
  }

  // 4c) forward-fill: 오늘 NAV·yield를 nav_history에 append (track record 시계열)
  const navRows = snapshots.map((s) => ({
    oracle_id: s.oracle_id,
    observed_date: runDate,
    nav: s.nav,
    yield_pct: yieldByOracle.get(s.oracle_id) ?? null,
    source: "forward-fill",
  }));
  sqlite.upsertNavHistory(navRows);

  // 5) 벤치마크 곡선 (US Treasury) → benchmarks 테이블
  let benchLog = "";
  if (benchCfg) {
    try {
      const year = Number(nowIso(nowMs).slice(0, 4));
      const curve = await fetchTreasuryCurve(benchCfg, year);
      const { inserted } = sqlite.upsertBenchmarks(curve.as_of, curve.rates, "us-treasury");
      benchLog =
        `벤치마크(US Treasury) as_of=${curve.as_of}: ` +
        Object.entries(curve.rates).map(([k, v]) => `${k}=${v}%`).join(" ") +
        ` (신규 ${inserted})`;
    } catch (err) {
      benchLog = `벤치마크 수집 실패: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`;
    }
  }

  sqlite.close();

  // 리포트
  console.log("\n" + "=".repeat(72));
  console.log(
    pad("oracle_id", 28) +
      pad("nav", 12) +
      pad("fresh", 8) +
      pad("grade", 6) +
      pad("attest", 10) +
      "feed_name",
  );
  console.log("-".repeat(84));
  for (const s of [...snapshots].sort((a, b) => a.oracle_id.localeCompare(b.oracle_id))) {
    const a = s.attestation;
    const attest =
      a && a.validator_count != null
        ? `${a.quorum ?? "?"}/${a.validator_count}`
        : "—";
    console.log(
      pad(s.oracle_id, 28) +
        pad(s.nav == null ? "—" : s.nav.toPrecision(6), 12) +
        pad(s.freshness, 8) +
        pad(s.trust_grade, 6) +
        pad(attest, 10) +
        (a?.feed_name ?? ""),
    );
  }
  console.log("-".repeat(84));
  console.log(
    `수집 성공 ${snapshots.length} / 실패 ${failures.length}  ` +
      `| JSON: 신규 ${result.appended}, 스킵 ${result.skipped}  ` +
      `| SQLite: 신규 ${sqlResult.appended}, 스킵 ${sqlResult.skipped}  ` +
      `| ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  if (failures.length) {
    console.log("\n실패(스킵됨, 다음 실행 재시도):");
    for (const f of failures) {
      console.log(`  · ${f.id}: ${f.reason.slice(0, 80)}`);
    }
  }
  if (holdingsLog.length) {
    console.log("\n오프체인 holdings:");
    for (const line of holdingsLog) console.log(line);
  }
  if (yieldLog.length) {
    console.log("\n토큰 yield:");
    for (const line of yieldLog) console.log(line);
  }
  if (benchLog) console.log("\n" + benchLog);

  console.log(
    "\n→ data/latest.csv·latest.json (대시보드), data/poa.sqlite (구조화 질의) 갱신됨",
  );
}

function pad(s: string, n: number): string {
  return (s.length > n ? s.slice(0, n - 1) : s).padEnd(n);
}
function nowIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error("[collect] 파이프라인 실패:", err);
  process.exit(1);
});
