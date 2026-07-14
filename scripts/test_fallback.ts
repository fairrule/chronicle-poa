// DoD 검증: 첫 RPC를 일부러 잘못된 URL로 두면 다음 fallback으로 성공하는지.
// 사용: npx tsx scripts/test_fallback.ts
import type { Address } from "viem";
import { callWithFallback, loadRpcConfig } from "../src/rpc.js";
import { AGGREGATOR_V3_ABI } from "../src/abi.js";

// BUIDL Ethereum adapter (verify에서 OK 확인된 주소)
const BUIDL_ADAPTER = "0x35cE8603C90A4286CF91C4c05EfaE4565Daf7eFb" as Address;

async function main() {
  const cfg = loadRpcConfig();
  // 첫 엔드포인트를 고의로 깨진 URL로 교체, 나머지는 정상 유지.
  const original = cfg.rpc.ethereum;
  cfg.rpc.ethereum = [
    "https://this-endpoint-does-not-exist.invalid",
    ...original,
  ];
  console.log("ethereum RPC 순서 (첫 번째는 고의로 깨진 URL):");
  cfg.rpc.ethereum.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));
  console.log("");

  const decimals = await callWithFallback<number>("ethereum", {
    address: BUIDL_ADAPTER,
    abi: AGGREGATOR_V3_ABI,
    functionName: "decimals",
  });

  console.log(`\n✅ fallback 성공 — decimals() = ${decimals}`);
  console.log("   첫 엔드포인트 실패 후 다음 엔드포인트로 자동 순회 확인됨.");
}

main().catch((err) => {
  console.error("❌ fallback 테스트 실패:", err);
  process.exit(1);
});
