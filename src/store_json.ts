// 로컬 JSON/CSV 저장 (구글 시트 대체 — 조직 정책이 서비스 계정 키를 차단하여 선택).
// - data/snapshots.json : append-only 전체 이력 (멱등 자연 키 (oracle_id, round_id))
// - data/latest.json / data/latest.csv : 오라클별 최신 라운드 1행 = 사람이 보는 대시보드
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AssetSnapshot } from "./types.js";
import { snapshotKey } from "./types.js";
import type { SnapshotStore, StoreResult } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT, "data");

// latest.csv / dashboard에 노출할 컬럼 (holdings 등 Tier-2 배열 제외)
const CSV_COLUMNS: (keyof AssetSnapshot)[] = [
  "oracle_id",
  "issuer",
  "asset_ticker",
  "chain",
  "round_id",
  "nav",
  "decimals",
  "raw_answer",
  "observed_at",
  "ingested_at",
  "freshness",
  "trust_grade",
  "custody_status",
  "source_address",
];

export class JsonStore implements SnapshotStore {
  private readonly historyPath: string;
  private readonly latestJsonPath: string;
  private readonly latestCsvPath: string;

  constructor(dataDir = DATA_DIR) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.historyPath = resolve(dataDir, "snapshots.json");
    this.latestJsonPath = resolve(dataDir, "latest.json");
    this.latestCsvPath = resolve(dataDir, "latest.csv");
  }

  private readHistory(): AssetSnapshot[] {
    if (!existsSync(this.historyPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.historyPath, "utf8"));
      return Array.isArray(parsed) ? (parsed as AssetSnapshot[]) : [];
    } catch {
      return [];
    }
  }

  async append(snapshots: AssetSnapshot[]): Promise<StoreResult> {
    const history = this.readHistory();
    const seen = new Set(history.map(snapshotKey));

    let appended = 0;
    let skipped = 0;
    for (const s of snapshots) {
      const key = snapshotKey(s);
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      history.push(s);
      appended++;
    }

    if (appended > 0) {
      writeFileSync(this.historyPath, JSON.stringify(history, null, 2));
    }
    // latest 뷰는 항상 재생성(최신 상태 반영)
    this.writeLatest(history);

    return { appended, skipped };
  }

  /** 오라클별 최신 라운드(observed_at 기준) 1행만 추려 대시보드용으로 기록. */
  private writeLatest(history: AssetSnapshot[]): void {
    const latestByOracle = new Map<string, AssetSnapshot>();
    for (const s of history) {
      const prev = latestByOracle.get(s.oracle_id);
      if (!prev || s.observed_at > prev.observed_at) {
        latestByOracle.set(s.oracle_id, s);
      }
    }
    const rows = [...latestByOracle.values()].sort((a, b) =>
      a.oracle_id.localeCompare(b.oracle_id),
    );

    writeFileSync(this.latestJsonPath, JSON.stringify(rows, null, 2));
    writeFileSync(this.latestCsvPath, toCsv(rows));
  }
}

// attestation은 중첩 객체라 별도 컬럼으로 평탄화
const ATTEST_COLUMNS = ["feed_name", "quorum", "validator_count", "latest_poke"] as const;

function toCsv(rows: AssetSnapshot[]): string {
  const header = [...CSV_COLUMNS, ...ATTEST_COLUMNS].join(",");
  const lines = rows.map((r) =>
    [
      ...CSV_COLUMNS.map((c) => csvCell(r[c])),
      csvCell(r.attestation?.feed_name),
      csvCell(r.attestation?.quorum),
      csvCell(r.attestation?.validator_count),
      csvCell(r.attestation?.latest_poke),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
