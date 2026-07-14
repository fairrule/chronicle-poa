// Etherscan V2 컨트랙트 인스펙터 (Phase 2 선행 조사).
// 주소의 소스/ABI를 가져와 view/pure 함수 중 "리치"한 것(struct/array/다중 반환)을 골라 출력.
// 프록시면 구현 주소의 ABI까지 따라간다.
//
// 사용: npx tsx scripts/inspect_contract.ts <address> [chainid=1] [--json]
import { requireEnv } from "../src/env.js";

const V2 = "https://api.etherscan.io/v2/api";

interface AbiInput {
  name: string;
  type: string;
  components?: AbiInput[];
}
interface AbiItem {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: AbiInput[];
  outputs?: AbiInput[];
}

async function esGet(params: Record<string, string>): Promise<any> {
  const key = requireEnv("ETHERSCAN_API_KEY");
  const url =
    `${V2}?` +
    new URLSearchParams({ ...params, apikey: key }).toString();
  const resp = await fetch(url);
  const json = (await resp.json()) as { status: string; message: string; result: any };
  return json;
}

async function getSource(chainid: string, address: string) {
  const j = await esGet({
    chainid,
    module: "contract",
    action: "getsourcecode",
    address,
  });
  if (j.status !== "1") {
    throw new Error(`getsourcecode 실패: ${j.message} — ${JSON.stringify(j.result).slice(0, 120)}`);
  }
  return j.result[0] as {
    ContractName: string;
    ABI: string;
    Proxy: string;
    Implementation: string;
  };
}

function typeStr(io: AbiInput): string {
  if (io.type.startsWith("tuple")) {
    const inner = (io.components ?? []).map((c) => `${typeStr(c)} ${c.name}`).join("; ");
    const suffix = io.type.slice("tuple".length); // [] 등
    return `(${inner})${suffix}`;
  }
  return io.type;
}

function isRich(item: AbiItem): boolean {
  const outs = item.outputs ?? [];
  if (outs.length === 0) return false;
  // struct/array 반환 또는 반환값 2개 이상 → Tier-2 후보
  if (outs.length >= 2) return true;
  return outs.some((o) => o.type.includes("tuple") || o.type.endsWith("[]"));
}

async function inspect(address: string, chainid: string, asJson: boolean) {
  let src = await getSource(chainid, address);
  console.log(`\n■ ${address} (chainid=${chainid})`);
  console.log(`  ContractName: ${src.ContractName || "(unverified)"}`);
  console.log(`  Proxy: ${src.Proxy}  Implementation: ${src.Implementation || "-"}`);

  let abiJson = src.ABI;
  // 프록시면 구현 ABI로 교체
  if (src.Proxy === "1" && src.Implementation && /^0x[0-9a-fA-F]{40}$/.test(src.Implementation)) {
    console.log(`  → 프록시 감지, 구현 ${src.Implementation} ABI 로드`);
    const impl = await getSource(chainid, src.Implementation);
    abiJson = impl.ABI;
    src = { ...src, ContractName: `${src.ContractName} → ${impl.ContractName}` };
  }

  if (abiJson === "Contract source code not verified") {
    console.log("  ⚠️ 미검증 컨트랙트 — ABI 없음. 프로빙 방식 필요.");
    return;
  }

  const abi = JSON.parse(abiJson) as AbiItem[];
  const views = abi.filter(
    (i) => i.type === "function" && (i.stateMutability === "view" || i.stateMutability === "pure"),
  );

  if (asJson) {
    console.log(JSON.stringify(views, null, 2));
    return;
  }

  const rich = views.filter(isRich);
  const scalar = views.filter((v) => !isRich(v));

  console.log(`\n  ── 리치 read 함수 (Tier-2 후보: struct/array/다중반환) ──`);
  if (rich.length === 0) console.log("    (없음)");
  for (const f of rich) {
    const ins = (f.inputs ?? []).map((i) => typeStr(i)).join(", ");
    const outs = (f.outputs ?? []).map((o) => typeStr(o)).join(", ");
    console.log(`    • ${f.name}(${ins}) → ${outs}`);
  }

  console.log(`\n  ── 스칼라 read 함수 (${scalar.length}개) ──`);
  console.log(
    "    " + scalar.map((f) => f.name).join(", "),
  );
}

async function main() {
  const [address, chainid = "1", flag] = process.argv.slice(2);
  if (!address) {
    console.error("사용: npx tsx scripts/inspect_contract.ts <address> [chainid] [--json]");
    process.exit(1);
  }
  await inspect(address, chainid, flag === "--json");
}

main().catch((err) => {
  console.error("인스펙터 실패:", err instanceof Error ? err.message : err);
  process.exit(1);
});
