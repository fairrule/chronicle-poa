// Canonical 데이터 모델 (명세 4장)
// int256/uint80은 문자열로 보존(정밀도 손실 방지). number는 표시용 스케일링만.

export type Chain = "ethereum" | "base" | "monad";
export type Freshness = "fresh" | "stale" | "expired";
export type TrustGrade = "A" | "B" | "C";
export type CustodyStatus = "verified" | "stale" | "failed" | "unknown";

export interface AssetSnapshot {
  oracle_id: string; // "securitize_buidl_eth"
  issuer: string;
  asset_ticker: string;
  chain: Chain;
  round_id: string; // uint80 → 문자열 (정밀도 보존)
  observed_at: string; // ISO8601, 온체인 updatedAt 기준
  ingested_at: string; // ISO8601, 수집 시각
  // Tier-1
  nav: number | null; // answer / 10**decimals
  raw_answer: string; // 원천 int256 문자열
  decimals: number;
  // Tier-2 (Phase 2~, 없으면 null/빈 배열)
  aum: number | null;
  yield_7d: number | null;
  holdings: Holding[];
  custody_status: CustodyStatus;
  // 검증
  freshness: Freshness; // observed_at 과 now 의 차이로 판정
  trust_grade: TrustGrade;
  source_address: string; // 실제 read 한 adapter/router 주소
  // attestation 메타데이터 (Chronicle VAO consumer에서 읽음 — 명세 부록 B의 신뢰 경계)
  attestation: Attestation | null;
}

/**
 * "누가·몇 명이 이 값에 서명하는가" — Proof of Asset의 신뢰 계층.
 * holdings가 온체인에 없으므로, 값의 무결성을 뒷받침하는 검증자 집합·쿼럼을 기록한다.
 */
export interface Attestation {
  consumer_address: string; // 실제 메타데이터를 읽은 consumer 주소
  feed_name: string | null; // 예: "VAO::Securitize_BUIDL"
  wat: string | null; // bytes32 태그 (hex)
  quorum: number | null; // barECDSA — 최소 서명 수
  validator_count: number | null; // 검증자 집합 크기
  validators: string[]; // 검증자 주소 목록 (ECDSA)
  latest_poke: string | null; // ISO8601, consumer 기준 마지막 갱신
}

export interface Holding {
  // Phase 2~
  instrument_type: string; // "treasury" | "repo" | "cash" | "clo" | ...
  identifier: string | null; // CUSIP/ISIN 등
  units: number | null;
  price: number | null;
  market_value: number;
  maturity_date: string | null;
  weight_pct: number; // 파생
}

/**
 * 멱등 자연 키: (oracle_id, round_id, observed_at).
 * 명세 §1.4가 "roundId(+ updatedAt)를 자연 키로" 라고 명시. Chronicle 어댑터는
 * roundId를 증가시키지 않고 1로 고정하는 경우가 많아, updatedAt(=observed_at)을
 * 반드시 포함해야 매일 갱신되는 값을 새 스냅샷으로 잡을 수 있다.
 */
export function snapshotKey(
  s: Pick<AssetSnapshot, "oracle_id" | "round_id" | "observed_at">,
): string {
  return `${s.oracle_id}::${s.round_id}::${s.observed_at}`;
}
