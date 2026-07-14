// 이력 백필 (명세 Phase 4). track record용 NAV·yield 시계열을 과거로 채운다.
//
// 무료 RPC는 archive eth_getLogs를 막으므로(Poked 이벤트 백필 불가), Centrifuge 자산은
// Centrifuge GraphQL의 TokenSnapshot 이력(무료, ~8개월)으로 채운다. 다른 자산은 cron이
// forward-fill로 쌓는다. 멱등이라 여러 번 돌려도 안전.
//
// 사용: npm run backfill
import { loadBenchmarkConfig, fetchCentrifugeNavHistory } from "../src/collect_benchmark.js";
import { SqliteStore } from "../src/store_sqlite.js";

async function main() {
  const cfg = loadBenchmarkConfig();
  if (!cfg) {
    console.error("config/benchmarks.yaml 없음");
    process.exit(1);
  }
  const sqlite = new SqliteStore();

  // Centrifuge yield 소스가 있는 오라클 = symbol 매핑 보유 → 이력 backfill 대상
  const targets = Object.entries(cfg.yields).filter(
    ([, s]) => s.source === "centrifuge-graphql" && s.symbol,
  );
  console.log(`Centrifuge 이력 백필 대상 ${targets.length}개 오라클...\n`);

  // 심볼별로 한 번만 fetch (같은 심볼 여러 오라클이 공유)
  const historyCache = new Map<string, Awaited<ReturnType<typeof fetchCentrifugeNavHistory>>>();

  for (const [oracleId, spec] of targets) {
    const symbol = spec.symbol as string;
    try {
      if (!historyCache.has(symbol)) {
        historyCache.set(
          symbol,
          await fetchCentrifugeNavHistory(symbol, spec.yield_field ?? "yield30d365"),
        );
      }
      const hist = historyCache.get(symbol)!;
      if (!hist.length) {
        console.log(`  · ${oracleId.padEnd(26)} (${symbol}) 이력 없음`);
        continue;
      }
      const { written } = sqlite.upsertNavHistory(
        hist.map((h) => ({
          oracle_id: oracleId,
          observed_date: h.observed_date,
          nav: h.nav,
          yield_pct: h.yield_pct,
          source: "centrifuge-backfill",
        })),
      );
      console.log(
        `  · ${oracleId.padEnd(26)} (${symbol}) ${hist.length}일 [${hist[0].observed_date}~${hist[hist.length - 1].observed_date}] 저장 ${written}`,
      );
    } catch (err) {
      console.log(`  · ${oracleId.padEnd(26)} 실패 — ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
    }
  }

  sqlite.close();
  console.log(
    "\n참고: 온체인 Poked 이벤트 백필은 무료 RPC archive 제약으로 불가. " +
      "비-Centrifuge 자산(USTB·BUIDL 등)은 cron forward-fill로 이력이 쌓인다.",
  );
}

main().catch((err) => {
  console.error("백필 실패:", err);
  process.exit(1);
});
