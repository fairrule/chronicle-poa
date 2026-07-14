// 정규화: raw Tier-1 → canonical AssetSnapshot (명세 Phase 1, 태스크 3 + 4장 규칙)
import type { RawTier1 } from "./collect_tier1.js";
import { loadRpcConfig } from "./rpc.js";
import type {
  AssetSnapshot,
  Attestation,
  Freshness,
  TrustGrade,
} from "./types.js";

const HOUR_MS = 3600_000;

/** now - observed_at 으로 freshness 판정 (명세 4장, 임계는 config). */
export function computeFreshness(
  observedAtMs: number,
  nowMs: number,
  freshMaxHours: number,
  staleMaxHours: number,
): Freshness {
  const ageHours = (nowMs - observedAtMs) / HOUR_MS;
  if (ageHours <= freshMaxHours) return "fresh";
  if (ageHours <= staleMaxHours) return "stale";
  return "expired";
}

/**
 * trust_grade 판정 (명세 4장):
 *  A: fresh + answer>0 + 정상 응답
 *  B: stale
 *  C: expired 또는 값 이상(0/음수)
 */
export function computeTrustGrade(
  freshness: Freshness,
  answer: bigint,
): TrustGrade {
  const anomalous = answer <= 0n;
  if (anomalous) return "C";
  if (freshness === "expired") return "C";
  if (freshness === "stale") return "B";
  return "A"; // fresh + answer>0
}

/** raw int256 answer + decimals → 사람이 읽는 number. 정밀도는 raw_answer 문자열로 보존. */
export function scaleAnswer(answer: bigint, decimals: number): number {
  // BigInt를 안전하게 number로: 정수부/소수부 분리 후 조합.
  const neg = answer < 0n;
  const abs = neg ? -answer : answer;
  const base = 10n ** BigInt(decimals);
  const intPart = abs / base;
  const fracPart = abs % base;
  const frac = Number(fracPart) / Number(base);
  const val = Number(intPart) + frac;
  return neg ? -val : val;
}

export function normalizeOne(
  raw: RawTier1,
  nowMs: number,
  attestation: Attestation | null = null,
): AssetSnapshot {
  const cfg = loadRpcConfig();
  const { fresh_max_hours, stale_max_hours } = cfg.freshness;

  const observedAtMs = Number(raw.updatedAt) * 1000;
  const freshness = computeFreshness(
    observedAtMs,
    nowMs,
    fresh_max_hours,
    stale_max_hours,
  );
  const trust_grade = computeTrustGrade(freshness, raw.answer);
  const nav = scaleAnswer(raw.answer, raw.decimals);

  return {
    oracle_id: raw.entry.id,
    issuer: raw.entry.issuer,
    asset_ticker: raw.entry.asset_ticker,
    chain: raw.entry.chain,
    round_id: raw.roundId.toString(),
    observed_at:
      raw.updatedAt > 0n ? new Date(observedAtMs).toISOString() : "",
    ingested_at: new Date(nowMs).toISOString(),
    // Tier-1
    nav: Number.isFinite(nav) ? nav : null,
    raw_answer: raw.answer.toString(),
    decimals: raw.decimals,
    // Tier-2 (Phase 2~ 에서 채움)
    aum: null,
    yield_7d: null,
    holdings: [],
    custody_status: "unknown",
    // 검증
    freshness,
    trust_grade,
    source_address: raw.entry.read_address,
    attestation,
  };
}
