// 레지스트리 로더·파서 (명세 Phase 0, 태스크 4)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export type Chain = "ethereum" | "base" | "monad";

export interface OracleEntry {
  id: string;
  issuer: string;
  asset_ticker: string;
  chain: Chain;
  adapter_address: string | null;
  router_address: string | null;
  /** Tier-1 read 대상: adapter가 있으면 adapter, 없으면 router. */
  read_address: string;
}

interface RawOracle {
  id: string;
  issuer: string;
  asset_ticker: string;
  chain: string;
  adapter_address: string | null;
  router_address: string | null;
}

const VALID_CHAINS: readonly Chain[] = ["ethereum", "base", "monad"];

// id 접미사(약칭) → 정식 chain 이름. 명명규칙 sanity check용.
const CHAIN_ALIASES: Record<string, Chain> = {
  eth: "ethereum",
  ethereum: "ethereum",
  base: "base",
  monad: "monad",
};

/**
 * id 명명규칙 파서: `<issuer>_<ticker>_<chain>`.
 * 구조 검증용 — 파싱 결과가 레지스트리 필드와 크게 어긋나면 경고만 남기고 진행한다.
 */
export function parseOracleId(id: string): {
  issuer: string;
  ticker: string;
  chain: string;
} | null {
  const parts = id.split("_");
  if (parts.length < 3) return null;
  const chain = parts[parts.length - 1];
  const issuer = parts[0];
  const ticker = parts.slice(1, parts.length - 1).join("_");
  return { issuer, ticker, chain };
}

export function loadRegistry(
  path = resolve(ROOT, "config/oracles.yaml"),
): OracleEntry[] {
  const doc = yaml.load(readFileSync(path, "utf8")) as { oracles?: RawOracle[] };
  if (!doc?.oracles || !Array.isArray(doc.oracles)) {
    throw new Error(`oracles.yaml: 'oracles' 배열을 찾을 수 없음 (${path})`);
  }

  const seen = new Set<string>();
  const entries: OracleEntry[] = [];

  for (const raw of doc.oracles) {
    if (!raw.id) throw new Error("oracles.yaml: id 없는 항목 존재");
    if (seen.has(raw.id)) throw new Error(`oracles.yaml: 중복 id ${raw.id}`);
    seen.add(raw.id);

    if (!VALID_CHAINS.includes(raw.chain as Chain)) {
      throw new Error(`${raw.id}: 알 수 없는 chain '${raw.chain}'`);
    }

    const adapter = normalizeAddr(raw.adapter_address);
    const router = normalizeAddr(raw.router_address);
    const readAddress = adapter ?? router;
    if (!readAddress) {
      throw new Error(`${raw.id}: adapter/router 주소가 모두 비어 있음`);
    }

    // 명명규칙 sanity check (실패해도 진행)
    const parsed = parseOracleId(raw.id);
    if (parsed && CHAIN_ALIASES[parsed.chain] !== raw.chain) {
      console.warn(
        `[registry] ${raw.id}: id의 chain(${parsed.chain})과 필드 chain(${raw.chain}) 불일치`,
      );
    }

    entries.push({
      id: raw.id,
      issuer: raw.issuer,
      asset_ticker: raw.asset_ticker,
      chain: raw.chain as Chain,
      adapter_address: adapter,
      router_address: router,
      read_address: readAddress,
    });
  }

  return entries;
}

export type AssetClass = "treasury" | "clo" | "credit" | "equity" | "unknown";

/** oracle_id → asset_class 맵 로드 (config/asset_class.yaml). 없으면 빈 맵. */
export function loadAssetClasses(
  path = resolve(ROOT, "config/asset_class.yaml"),
): Map<string, AssetClass> {
  const map = new Map<string, AssetClass>();
  try {
    const doc = yaml.load(readFileSync(path, "utf8")) as {
      asset_class?: Record<string, AssetClass>;
    };
    for (const [k, v] of Object.entries(doc?.asset_class ?? {})) map.set(k, v);
  } catch {
    /* 파일 없으면 빈 맵 */
  }
  return map;
}

function normalizeAddr(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "" || t === "—" || t === "-") return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) {
    throw new Error(`잘못된 주소 형식: ${v}`);
  }
  return t;
}
