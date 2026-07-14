// 주소 온체인 검증 (명세 Phase 0, 태스크 6 + DoD)
// 전 레지스트리에 대해 decimals() / latestRoundData() 호출 시도 → 응답/무응답 리포트.
//
// 사용: npm run verify   (또는  npx tsx scripts/verify_addresses.ts)
import type { Address } from "viem";
import { loadRegistry, type OracleEntry } from "../src/registry.js";
import { callWithFallback } from "../src/rpc.js";
import { AGGREGATOR_V3_ABI, type LatestRoundData } from "../src/abi.js";

interface VerifyResult {
  id: string;
  chain: string;
  read: "adapter" | "router";
  address: string;
  decimals: number | null;
  round_id: string | null;
  answer: string | null;
  updated_at: string | null;
  status: "OK" | "PARTIAL" | "FAIL";
  note: string;
}

async function verifyOne(entry: OracleEntry): Promise<VerifyResult> {
  const address = entry.read_address as Address;
  const readKind = entry.adapter_address ? "adapter" : "router";
  const base = {
    id: entry.id,
    chain: entry.chain,
    read: readKind as "adapter" | "router",
    address,
  };

  // 1) decimals()
  let decimals: number | null = null;
  try {
    const d = await callWithFallback<number>(
      entry.chain,
      { address, abi: AGGREGATOR_V3_ABI, functionName: "decimals" },
      { quiet: true },
    );
    decimals = Number(d);
  } catch (err) {
    return {
      ...base,
      decimals: null,
      round_id: null,
      answer: null,
      updated_at: null,
      status: "FAIL",
      note: firstLine(err),
    };
  }

  // 2) latestRoundData()
  try {
    const r = await callWithFallback<
      [bigint, bigint, bigint, bigint, bigint]
    >(
      entry.chain,
      { address, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" },
      { quiet: true },
    );
    const round: LatestRoundData = {
      roundId: r[0],
      answer: r[1],
      startedAt: r[2],
      updatedAt: r[3],
      answeredInRound: r[4],
    };
    const updatedIso =
      round.updatedAt > 0n
        ? new Date(Number(round.updatedAt) * 1000).toISOString()
        : null;
    return {
      ...base,
      decimals,
      round_id: round.roundId.toString(),
      answer: round.answer.toString(),
      updated_at: updatedIso,
      status: "OK",
      note: "",
    };
  } catch (err) {
    // decimals는 됐지만 latestRoundData 실패 → 부분 응답
    return {
      ...base,
      decimals,
      round_id: null,
      answer: null,
      updated_at: null,
      status: "PARTIAL",
      note: `latestRoundData 실패: ${firstLine(err)}`,
    };
  }
}

async function main() {
  const registry = loadRegistry();
  console.log(`레지스트리 ${registry.length}개 오라클 검증 시작...\n`);

  const results: VerifyResult[] = [];
  // 오라클별 독립 실행 (개별 실패가 전체를 멈추지 않게)
  for (const entry of registry) {
    process.stdout.write(`  · ${entry.id.padEnd(28)} `);
    const r = await verifyOne(entry);
    results.push(r);
    const scaled =
      r.answer && r.decimals != null
        ? (Number(r.answer) / 10 ** r.decimals).toPrecision(6)
        : "—";
    console.log(`${r.status.padEnd(7)} decimals=${r.decimals ?? "—"} nav≈${scaled}`);
  }

  // 요약 테이블
  console.log("\n" + "=".repeat(78));
  console.log("검증 결과 요약");
  console.log("=".repeat(78));
  console.log(
    pad("id", 28) + pad("chain", 9) + pad("read", 8) + pad("status", 8) + "note",
  );
  console.log("-".repeat(78));
  for (const r of results) {
    console.log(
      pad(r.id, 28) +
        pad(r.chain, 9) +
        pad(r.read, 8) +
        pad(r.status, 8) +
        (r.note || "").slice(0, 40),
    );
  }

  const ok = results.filter((r) => r.status === "OK").length;
  const partial = results.filter((r) => r.status === "PARTIAL").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log("-".repeat(78));
  console.log(`OK=${ok}  PARTIAL=${partial}  FAIL=${fail}  (총 ${results.length})`);

  // DoD: 최소 1개 오라클에서 정상 응답
  if (ok === 0) {
    console.error("\n⚠️  정상 응답한 오라클이 하나도 없습니다. RPC/주소를 점검하세요.");
    process.exit(1);
  }
}

function pad(s: string, n: number): string {
  return (s.length > n ? s.slice(0, n - 1) : s).padEnd(n);
}
function firstLine(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split("\n")[0].slice(0, 120);
}

main().catch((err) => {
  console.error("검증 스크립트 실패:", err);
  process.exit(1);
});
