// Tier-1 수집 (명세 Phase 1, 태스크 2)
// 전 레지스트리 순회, 각 오라클에서 latestRoundData() + decimals() read → raw 결과 배열.
// 개별 오라클 실패가 전체 실행을 멈추지 않게 오라클별 try/catch.
import type { Address } from "viem";
import type { OracleEntry } from "./registry.js";
import { callWithFallback } from "./rpc.js";
import { AGGREGATOR_V3_ABI } from "./abi.js";

export interface RawTier1 {
  entry: OracleEntry;
  ok: true;
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
  decimals: number;
}

export interface RawTier1Fail {
  entry: OracleEntry;
  ok: false;
  reason: string;
}

export type CollectResult = RawTier1 | RawTier1Fail;

async function collectOne(entry: OracleEntry): Promise<CollectResult> {
  const address = entry.read_address as Address;
  try {
    // decimals + latestRoundData. quiet=false로 fallback 로그 노출.
    const decimals = Number(
      await callWithFallback<number>(entry.chain, {
        address,
        abi: AGGREGATOR_V3_ABI,
        functionName: "decimals",
      }),
    );
    const r = await callWithFallback<[bigint, bigint, bigint, bigint, bigint]>(
      entry.chain,
      { address, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" },
    );
    return {
      entry,
      ok: true,
      roundId: r[0],
      answer: r[1],
      startedAt: r[2],
      updatedAt: r[3],
      answeredInRound: r[4],
      decimals,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { entry, ok: false, reason };
  }
}

/** 전 레지스트리 Tier-1 수집. 실패 항목도 결과 배열에 포함(호출부에서 로깅). */
export async function collectTier1(
  registry: OracleEntry[],
): Promise<CollectResult[]> {
  const results: CollectResult[] = [];
  for (const entry of registry) {
    results.push(await collectOne(entry));
  }
  return results;
}
