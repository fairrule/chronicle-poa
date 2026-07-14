// Attestation 메타데이터 수집 (Phase 2 — 명세 부록 B의 신뢰 경계).
// read_address(adapter/router)에서 Chronicle VAO consumer 주소를 해석한 뒤,
// 검증자 집합·쿼럼·피드명·latestPoke를 읽는다. holdings는 온체인에 없으므로
// 이 attestation이 "값의 무결성을 누가 보증하는가"를 담는 실질 Tier-2다.
import type { Address } from "viem";
import type { OracleEntry } from "./registry.js";
import { callWithFallback } from "./rpc.js";
import { CHRONICLE_META_ABI } from "./abi.js";
import type { Attestation } from "./types.js";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

async function tryRead<T>(
  chain: OracleEntry["chain"],
  address: Address,
  fn: string,
): Promise<T | null> {
  try {
    return await callWithFallback<T>(
      chain,
      { address, abi: CHRONICLE_META_ABI, functionName: fn },
      { quiet: true },
    );
  } catch {
    return null;
  }
}

/** read_address → consumer 주소 해석. adapter.router()→router.uscribe(), 또는 직접 uscribe(). */
async function resolveConsumer(
  entry: OracleEntry,
  from: Address,
): Promise<Address | null> {
  // 1) from.uscribe()
  const direct = await tryRead<string>(entry.chain, from, "uscribe");
  if (direct && ADDR_RE.test(direct) && direct !== ZERO) return direct as Address;

  // 2) from.router() → router.uscribe()
  const router = await tryRead<string>(entry.chain, from, "router");
  if (router && ADDR_RE.test(router) && router !== ZERO) {
    const viaRouter = await tryRead<string>(entry.chain, router as Address, "uscribe");
    if (viaRouter && ADDR_RE.test(viaRouter) && viaRouter !== ZERO) {
      return viaRouter as Address;
    }
  }

  // 3) from 자체가 consumer일 수 있음 — name()으로 판별
  const name = await tryRead<string>(entry.chain, from, "name");
  if (name != null) return from;

  return null;
}

function hexToUtf8(hex: string | null): string | null {
  if (!hex) return null;
  try {
    const s = Buffer.from(hex.replace(/^0x/, ""), "hex")
      .toString("utf8")
      .replace(/\0+$/, "");
    // 인쇄 가능한 ASCII만 의미 있음 (아니면 태그가 해시일 수 있음)
    return /^[\x20-\x7e]+$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** 오라클 하나의 attestation 수집. 실패해도 null 반환(전체 파이프라인 안 멈춤). */
export async function collectAttestation(
  entry: OracleEntry,
): Promise<Attestation | null> {
  const from = entry.read_address as Address;
  const consumer = await resolveConsumer(entry, from);
  if (!consumer) return null;

  const [name, watHex, bar, poke, validators] = await Promise.all([
    tryRead<string>(entry.chain, consumer, "name"),
    tryRead<string>(entry.chain, consumer, "wat"),
    tryRead<number>(entry.chain, consumer, "barECDSA"),
    tryRead<number>(entry.chain, consumer, "latestPoke"),
    tryRead<readonly string[]>(entry.chain, consumer, "validatorsECDSA"),
  ]);

  // wat는 보통 사람이 읽을 수 있는 태그(예: "BTC/USD")면 그걸, 아니면 hex 원본 보존.
  const watReadable = hexToUtf8(watHex);

  return {
    consumer_address: consumer,
    feed_name: name ?? null,
    wat: watReadable ?? watHex ?? null,
    quorum: bar != null ? Number(bar) : null,
    validator_count: validators ? validators.length : null,
    validators: validators ? [...validators] : [],
    latest_poke:
      poke != null && Number(poke) > 0
        ? new Date(Number(poke) * 1000).toISOString()
        : null,
  };
}
