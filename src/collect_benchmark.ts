// 벤치마크 + yield 수집 (Phase 3 벤치마크 스프레드).
// - US Treasury par yield curve(무료 XML)에서 위험자유금리 테너별 최신값
// - 자산별 토큰 yield (API 또는 수동값)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CFG_PATH = resolve(ROOT, "config/benchmarks.yaml");

interface YieldSpec {
  source: string;
  url?: string;
  field?: string;
  scale?: number;
  value_pct?: number;
  as_of_field?: string; // 응답 내 기준일 경로 (기본 as_of_date)
  as_of?: string; // manual 값의 기준일
  note?: string; // manual 값의 출처 설명 (source 컬럼에 저장)
  source_url?: string;
  // centrifuge-graphql 용
  symbol?: string;
  yield_field?: string; // 예: yield30d365 (RAY 1e27 고정소수점)
}

const CENTRIFUGE_API = "https://api.centrifuge.io";
const RAY = 1e27;

// 심볼 → 토큰 id 캐시 (실행당 1회 fetch)
let _cfgTokenMap: Map<string, string> | null = null;
async function centrifugeTokenId(symbol: string): Promise<string | null> {
  if (!_cfgTokenMap) {
    _cfgTokenMap = new Map();
    try {
      const resp = await fetch(CENTRIFUGE_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "query{tokens(limit:100){items{id symbol}}}" }),
      });
      const doc = (await resp.json()) as {
        data?: { tokens?: { items?: { id: string; symbol: string }[] } };
      };
      for (const t of doc.data?.tokens?.items ?? []) {
        // 같은 심볼 여러 체인이면 첫 항목(=펀드 수준 yield 동일)
        if (!_cfgTokenMap.has(t.symbol)) _cfgTokenMap.set(t.symbol, t.id);
      }
    } catch {
      /* 실패 시 빈 맵 */
    }
  }
  return _cfgTokenMap.get(symbol) ?? null;
}

/** Centrifuge 토큰의 최신 스냅샷 yield(%) fetch. RAY(1e27) → %. */
async function fetchCentrifugeYield(
  symbol: string,
  yieldField: string,
): Promise<{ pct: number; as_of: string } | null> {
  const tokenId = await centrifugeTokenId(symbol);
  if (!tokenId) return null;
  const q =
    `query{tokenSnapshots(where:{id_starts_with:"${tokenId}"},orderBy:"timestamp",` +
    `orderDirection:"desc",limit:1){items{timestamp ${yieldField}}}}`;
  const resp = await fetch(CENTRIFUGE_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const doc = (await resp.json()) as {
    data?: { tokenSnapshots?: { items?: Record<string, string>[] } };
  };
  const item = doc.data?.tokenSnapshots?.items?.[0];
  if (!item) return null;
  const raw = item[yieldField];
  if (raw == null) return null;
  const pct = (Number(raw) / RAY) * 100;
  if (!Number.isFinite(pct)) return null;
  const ts = Number(item.timestamp);
  const as_of = Number.isFinite(ts)
    ? new Date(ts).toISOString().slice(0, 10)
    : "";
  return { pct, as_of };
}

export interface YieldResult {
  pct: number;
  as_of: string; // YYYY-MM-DD
  source: string;
}
export interface BenchmarkConfig {
  treasury_curve: { url: string; tenors: Record<string, string> };
  tenor_by_wam: { max_days: number; tenor: string }[];
  default_tenor: string;
  yields: Record<string, YieldSpec>;
}

export function loadBenchmarkConfig(path = CFG_PATH): BenchmarkConfig | null {
  if (!existsSync(path)) return null;
  return yaml.load(readFileSync(path, "utf8")) as BenchmarkConfig;
}

export interface TreasuryCurve {
  as_of: string; // 마지막 관측일 (YYYY-MM-DD)
  rates: Record<string, number>; // tenor key(m1/m3/...) → % (예: 3.85)
}

/** Treasury XML에서 테너별 최신 par yield(%)를 파싱. */
export function parseTreasuryXml(
  xml: string,
  tenors: Record<string, string>,
): TreasuryCurve {
  const dates = [...xml.matchAll(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/g)].map(
    (m) => m[1].slice(0, 10),
  );
  const asOf = dates.length ? dates[dates.length - 1] : "";
  const rates: Record<string, number> = {};
  for (const [key, tag] of Object.entries(tenors)) {
    const re = new RegExp(`<d:${tag}[^>]*>([^<]*)</d:${tag}>`, "g");
    const vals = [...xml.matchAll(re)].map((m) => m[1]).filter((v) => v !== "");
    const last = vals.length ? Number(vals[vals.length - 1]) : NaN;
    if (Number.isFinite(last)) rates[key] = last;
  }
  return { as_of: asOf, rates };
}

/** 현재 연도의 Treasury 곡선 fetch. year는 테스트/재현용 주입. */
export async function fetchTreasuryCurve(
  cfg: BenchmarkConfig,
  year: number,
): Promise<TreasuryCurve> {
  const url = cfg.treasury_curve.url.replace("{year}", String(year));
  const resp = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!resp.ok) throw new Error(`Treasury curve HTTP ${resp.status}`);
  const xml = await resp.text();
  return parseTreasuryXml(xml, cfg.treasury_curve.tenors);
}

/** 점 경로 값 추출 */
function dget(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

function toIsoDate(v: unknown, fallback: string): string {
  if (v == null) return fallback;
  const s = String(v).trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // M/D/YYYY
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return fallback;
}

/** 자산별 토큰 yield(%) + as_of fetch. 실패 시 null. runDate는 manual/누락 시 fallback. */
export async function fetchYield(
  spec: YieldSpec,
  runDate: string,
): Promise<YieldResult | null> {
  if (spec.source === "manual") {
    return typeof spec.value_pct === "number"
      ? { pct: spec.value_pct, as_of: spec.as_of || runDate, source: spec.note || "manual" }
      : null;
  }
  if (spec.source === "centrifuge-graphql") {
    if (!spec.symbol || !spec.yield_field) return null;
    try {
      const r = await fetchCentrifugeYield(spec.symbol, spec.yield_field);
      return r ? { pct: r.pct, as_of: r.as_of || runDate, source: spec.source } : null;
    } catch {
      return null;
    }
  }
  if (!spec.url || !spec.field) return null;
  try {
    const resp = await fetch(spec.url, { headers: { accept: "application/json" } });
    if (!resp.ok) return null;
    const doc = (await resp.json()) as unknown;
    const n = Number(dget(doc, spec.field));
    if (!Number.isFinite(n)) return null;
    const asOf = toIsoDate(dget(doc, spec.as_of_field ?? "as_of_date"), runDate);
    return { pct: n * (spec.scale ?? 1), as_of: asOf, source: spec.source };
  } catch {
    return null;
  }
}

export interface NavHistoryPoint {
  observed_date: string; // YYYY-MM-DD
  nav: number;
  yield_pct: number | null;
}

/**
 * Centrifuge 토큰의 NAV·yield 이력 (일별). archive RPC 없이 GraphQL로 track record 확보.
 * tokenPrice(1e18) → NAV, yieldField(RAY 1e27) → %. 하루 여러 스냅샷이면 마지막(최신)만.
 */
export async function fetchCentrifugeNavHistory(
  symbol: string,
  yieldField = "yield30d365",
  limit = 500,
): Promise<NavHistoryPoint[]> {
  const tokenId = await centrifugeTokenId(symbol);
  if (!tokenId) return [];
  const q =
    `query{tokenSnapshots(where:{id_starts_with:"${tokenId}"},orderBy:"timestamp",` +
    `orderDirection:"desc",limit:${limit}){items{timestamp tokenPrice ${yieldField}}}}`;
  const resp = await fetch(CENTRIFUGE_API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const doc = (await resp.json()) as {
    data?: { tokenSnapshots?: { items?: Record<string, string>[] } };
  };
  const items = doc.data?.tokenSnapshots?.items ?? [];
  // 일별 dedupe: timestamp desc 이므로 각 날짜 첫 등장(=그날 최신)만 채택
  const byDate = new Map<string, NavHistoryPoint>();
  for (const it of items) {
    const ts = Number(it.timestamp);
    if (!Number.isFinite(ts)) continue;
    const date = new Date(ts).toISOString().slice(0, 10);
    if (byDate.has(date)) continue;
    const nav = Number(it.tokenPrice) / 1e18;
    const yraw = it[yieldField];
    const yield_pct = yraw != null ? (Number(yraw) / RAY) * 100 : null;
    if (Number.isFinite(nav)) byDate.set(date, { observed_date: date, nav, yield_pct });
  }
  return [...byDate.values()].sort((a, b) => a.observed_date.localeCompare(b.observed_date));
}

/** WAM(일) → 벤치마크 테너 키 선택. */
export function tenorForWam(cfg: BenchmarkConfig, wamDays: number | null): string {
  if (wamDays == null) return cfg.default_tenor;
  for (const rule of cfg.tenor_by_wam) {
    if (wamDays <= rule.max_days) return rule.tenor;
  }
  return cfg.default_tenor;
}
