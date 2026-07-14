// SQLite 저장 (명세 Phase 2, 태스크 3). better-sqlite3.
// - snapshots : Tier-1 미러 + attestation 메타데이터
// - snapshot_validators : 스냅샷별 검증자 집합 (1:N)
// - holdings : 오프체인 holdings (1:N, Phase 2b에서 채움) — canonical Holding 스키마
// 멱등 자연 키: (oracle_id, round_id, observed_at).
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { AssetSnapshot, Holding } from "./types.js";
import type { SnapshotStore, StoreResult } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_PATH = resolve(ROOT, "data/poa.sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  oracle_id       TEXT NOT NULL,
  round_id        TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  ingested_at     TEXT NOT NULL,
  issuer          TEXT,
  asset_ticker    TEXT,
  chain           TEXT,
  nav             REAL,
  raw_answer      TEXT,
  decimals        INTEGER,
  aum             REAL,
  yield_7d        REAL,
  custody_status  TEXT,
  freshness       TEXT,
  trust_grade     TEXT,
  source_address  TEXT,
  -- attestation
  consumer_address TEXT,
  feed_name        TEXT,
  wat              TEXT,
  quorum           INTEGER,
  validator_count  INTEGER,
  latest_poke      TEXT,
  PRIMARY KEY (oracle_id, round_id, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_snap_oracle ON snapshots(oracle_id, observed_at);

CREATE TABLE IF NOT EXISTS snapshot_validators (
  oracle_id         TEXT NOT NULL,
  round_id          TEXT NOT NULL,
  observed_at       TEXT NOT NULL,
  scheme            TEXT NOT NULL,        -- 'ecdsa'
  validator_address TEXT NOT NULL,
  PRIMARY KEY (oracle_id, round_id, observed_at, scheme, validator_address)
);

CREATE TABLE IF NOT EXISTS holdings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  oracle_id       TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  instrument_type TEXT,
  identifier      TEXT,                   -- CUSIP/ISIN
  units           REAL,
  price           REAL,
  market_value    REAL,
  maturity_date   TEXT,
  weight_pct      REAL,
  source          TEXT,                   -- 데이터 출처 (오프체인 발행사 등)
  UNIQUE(oracle_id, observed_at, identifier, source)
);
CREATE INDEX IF NOT EXISTS idx_holdings_snap ON holdings(oracle_id, observed_at);

CREATE TABLE IF NOT EXISTS benchmarks (
  observed_date TEXT NOT NULL,     -- YYYY-MM-DD (곡선 as_of)
  tenor         TEXT NOT NULL,     -- m1/m3/m6/y1
  rate_pct      REAL NOT NULL,     -- 위험자유금리 %
  source        TEXT,              -- 'us-treasury'
  PRIMARY KEY (observed_date, tenor)
);

CREATE TABLE IF NOT EXISTS yields (
  oracle_id   TEXT NOT NULL,
  as_of       TEXT NOT NULL,       -- yield 기준일 (YYYY-MM-DD)
  yield_pct   REAL NOT NULL,
  source      TEXT,
  PRIMARY KEY (oracle_id, as_of)
);

-- track record 시계열 (일별 NAV·yield). backfill(Centrifuge) + forward-fill(cron).
CREATE TABLE IF NOT EXISTS nav_history (
  oracle_id     TEXT NOT NULL,
  observed_date TEXT NOT NULL,     -- YYYY-MM-DD
  nav           REAL,
  yield_pct     REAL,
  source        TEXT,
  PRIMARY KEY (oracle_id, observed_date)
);
CREATE INDEX IF NOT EXISTS idx_navhist_oracle ON nav_history(oracle_id, observed_date);
`;

export class SqliteStore implements SnapshotStore {
  private readonly db: Database.Database;

  constructor(dbPath = DEFAULT_PATH) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  async append(snapshots: AssetSnapshot[]): Promise<StoreResult> {
    const existsStmt = this.db.prepare(
      "SELECT 1 FROM snapshots WHERE oracle_id=? AND round_id=? AND observed_at=?",
    );
    const insertSnap = this.db.prepare(`
      INSERT INTO snapshots (
        oracle_id, round_id, observed_at, ingested_at, issuer, asset_ticker, chain,
        nav, raw_answer, decimals, aum, yield_7d, custody_status,
        freshness, trust_grade, source_address,
        consumer_address, feed_name, wat, quorum, validator_count, latest_poke
      ) VALUES (
        @oracle_id, @round_id, @observed_at, @ingested_at, @issuer, @asset_ticker, @chain,
        @nav, @raw_answer, @decimals, @aum, @yield_7d, @custody_status,
        @freshness, @trust_grade, @source_address,
        @consumer_address, @feed_name, @wat, @quorum, @validator_count, @latest_poke
      )`);
    const insertValidator = this.db.prepare(`
      INSERT OR IGNORE INTO snapshot_validators
        (oracle_id, round_id, observed_at, scheme, validator_address)
      VALUES (?, ?, ?, 'ecdsa', ?)`);

    let appended = 0;
    let skipped = 0;

    const tx = this.db.transaction((rows: AssetSnapshot[]) => {
      for (const s of rows) {
        if (existsStmt.get(s.oracle_id, s.round_id, s.observed_at)) {
          skipped++;
          continue;
        }
        const a = s.attestation;
        insertSnap.run({
          oracle_id: s.oracle_id,
          round_id: s.round_id,
          observed_at: s.observed_at,
          ingested_at: s.ingested_at,
          issuer: s.issuer,
          asset_ticker: s.asset_ticker,
          chain: s.chain,
          nav: s.nav,
          raw_answer: s.raw_answer,
          decimals: s.decimals,
          aum: s.aum,
          yield_7d: s.yield_7d,
          custody_status: s.custody_status,
          freshness: s.freshness,
          trust_grade: s.trust_grade,
          source_address: s.source_address,
          consumer_address: a?.consumer_address ?? null,
          feed_name: a?.feed_name ?? null,
          wat: a?.wat ?? null,
          quorum: a?.quorum ?? null,
          validator_count: a?.validator_count ?? null,
          latest_poke: a?.latest_poke ?? null,
        });
        for (const v of a?.validators ?? []) {
          insertValidator.run(s.oracle_id, s.round_id, s.observed_at, v);
        }
        appended++;
      }
    });
    tx(snapshots);

    return { appended, skipped };
  }

  /** 오프체인 holdings 저장 (Phase 2b). 같은 (oracle_id, observed_at, identifier, source)는 멱등. */
  upsertHoldings(
    oracleId: string,
    observedAt: string,
    holdings: Holding[],
    source: string,
  ): { inserted: number } {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO holdings
        (oracle_id, observed_at, instrument_type, identifier, units, price,
         market_value, maturity_date, weight_pct, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const h of holdings) {
        const r = stmt.run(
          oracleId,
          observedAt,
          h.instrument_type,
          h.identifier,
          h.units,
          h.price,
          h.market_value,
          h.maturity_date,
          h.weight_pct,
          source,
        );
        if (r.changes > 0) inserted++;
      }
    });
    tx();
    return { inserted };
  }

  /** 벤치마크 곡선(테너별 금리) 멱등 저장. */
  upsertBenchmarks(
    observedDate: string,
    rates: Record<string, number>,
    source: string,
  ): { inserted: number } {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO benchmarks (observed_date, tenor, rate_pct, source) VALUES (?, ?, ?, ?)`,
    );
    let inserted = 0;
    const tx = this.db.transaction(() => {
      for (const [tenor, rate] of Object.entries(rates)) {
        if (stmt.run(observedDate, tenor, rate, source).changes > 0) inserted++;
      }
    });
    tx();
    return { inserted };
  }

  /** NAV 이력 upsert (일별). 최신 값으로 갱신(REPLACE) — backfill/forward-fill 공용. */
  upsertNavHistory(
    rows: { oracle_id: string; observed_date: string; nav: number | null; yield_pct: number | null; source: string }[],
  ): { written: number } {
    const stmt = this.db.prepare(
      `INSERT INTO nav_history (oracle_id, observed_date, nav, yield_pct, source)
       VALUES (@oracle_id, @observed_date, @nav, @yield_pct, @source)
       ON CONFLICT(oracle_id, observed_date) DO UPDATE SET
         nav=COALESCE(excluded.nav, nav_history.nav),
         yield_pct=COALESCE(excluded.yield_pct, nav_history.yield_pct),
         source=excluded.source`,
    );
    let written = 0;
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        stmt.run(r);
        written++;
      }
    });
    tx();
    return { written };
  }

  /** 자산별 yield 멱등 저장. */
  upsertYield(oracleId: string, asOf: string, yieldPct: number, source: string): { inserted: number } {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO yields (oracle_id, as_of, yield_pct, source) VALUES (?, ?, ?, ?)`)
      .run(oracleId, asOf, yieldPct, source);
    return { inserted: r.changes };
  }

  close(): void {
    this.db.close();
  }
}
