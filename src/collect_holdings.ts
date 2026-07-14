// 오프체인 holdings 제너릭 커넥터 (Phase 2b).
// config/offchain/<oracle_id>.yaml 정의를 해석해 발행사 소스에서 holdings를 가져와
// canonical Holding[]으로 매핑한다. 코드는 정의를 해석하는 제너릭 디코더(자산 추가=YAML만).
//
// 온체인 read-only 경계를 벗어나는 유일한 부분(발행사 공개 API). 각 행에 source 태그를 남긴다.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import type { Holding } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OFFCHAIN_DIR = resolve(ROOT, "config/offchain");

type ParseKind = "money" | "percent" | "date_dmy" | "str" | "none";

interface FieldSpec {
  path?: string;
  const?: unknown;
  parse?: ParseKind;
}

export interface OffchainSource {
  oracle_id: string;
  source: string;
  type: "json_http";
  url: string;
  holdings_path: string;
  as_of_path?: string;
  fields: Record<string, FieldSpec>;
}

export interface HoldingsResult {
  oracle_id: string;
  source: string;
  as_of: string; // ISO date (holdings 스냅샷 기준)
  holdings: Holding[];
}

export function loadOffchainSources(): OffchainSource[] {
  if (!existsSync(OFFCHAIN_DIR)) return [];
  return readdirSync(OFFCHAIN_DIR)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => yaml.load(readFileSync(resolve(OFFCHAIN_DIR, f), "utf8")) as OffchainSource);
}

export function getOffchainSource(oracleId: string): OffchainSource | null {
  return loadOffchainSources().find((s) => s.oracle_id === oracleId) ?? null;
}

/** 점 경로로 중첩 값 추출 */
function dget(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

function parseValue(raw: unknown, kind: ParseKind = "none"): unknown {
  if (raw == null) return null;
  const s = String(raw).trim();
  switch (kind) {
    case "money": {
      const n = Number(s.replace(/[$,\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "percent": {
      const n = Number(s.replace(/[%\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "date_dmy":
      return parseDateDMY(s);
    case "str":
      return s;
    default:
      return raw;
  }
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** "26-May-2026" → "2026-05-26". 실패 시 원본 반환. */
function parseDateDMY(s: string): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (!m) return s;
  const day = m[1].padStart(2, "0");
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return s;
  return `${m[3]}-${mon}-${day}`;
}

function mapField(row: Record<string, unknown>, spec: FieldSpec): unknown {
  if (spec.const !== undefined) return spec.const;
  if (spec.path === undefined) return null;
  return parseValue(dget(row, spec.path), spec.parse);
}

/** 정의를 해석해 원시 행 배열 → Holding[] 매핑 (fetch 없이, 테스트 용이). */
export function mapHoldings(
  rows: Record<string, unknown>[],
  fields: Record<string, FieldSpec>,
): Holding[] {
  return rows.map((row) => {
    const g = (k: string) => mapField(row, fields[k] ?? {});
    const mv = num(g("market_value"));
    return {
      instrument_type: str(g("instrument_type")) ?? "unknown",
      identifier: str(g("identifier")),
      units: num(g("units")),
      price: num(g("price")),
      market_value: mv ?? 0,
      maturity_date: str(g("maturity_date")),
      weight_pct: num(g("weight_pct")) ?? 0,
    };
  });
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function toIsoDate(v: unknown): string {
  if (v == null) return "";
  const s = String(v).trim();
  // "5/22/2026" (M/D/YYYY) → ISO date
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return s;
}

/** 소스 정의로 실제 holdings를 fetch + 매핑. */
export async function fetchHoldings(src: OffchainSource): Promise<HoldingsResult> {
  if (src.type !== "json_http") {
    throw new Error(`${src.oracle_id}: 지원하지 않는 소스 타입 ${src.type}`);
  }
  const resp = await fetch(src.url, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error(`${src.oracle_id}: HTTP ${resp.status} (${src.url})`);
  const doc = (await resp.json()) as unknown;

  const arr = dget(doc, src.holdings_path);
  if (!Array.isArray(arr)) {
    throw new Error(`${src.oracle_id}: holdings_path '${src.holdings_path}'가 배열 아님`);
  }
  const holdings = mapHoldings(arr as Record<string, unknown>[], src.fields);
  const as_of = src.as_of_path ? toIsoDate(dget(doc, src.as_of_path)) : "";

  return { oracle_id: src.oracle_id, source: src.source, as_of, holdings };
}
