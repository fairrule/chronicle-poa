// 멀티 RPC fallback 클라이언트 (명세 Phase 0, 태스크 5)
// viem createPublicClient + http transport를 체인별 엔드포인트 배열로 순회 fallback.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import yaml from "js-yaml";
import {
  createPublicClient,
  http,
  type Abi,
  type Address,
  type PublicClient,
} from "viem";
import type { Chain } from "./registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export interface RpcConfig {
  rpc: Record<Chain, string[]>;
  freshness: { fresh_max_hours: number; stale_max_hours: number };
}

let _config: RpcConfig | null = null;

export function loadRpcConfig(
  path = resolve(ROOT, "config/rpc.yaml"),
): RpcConfig {
  if (_config) return _config;
  const doc = yaml.load(readFileSync(path, "utf8")) as Partial<RpcConfig>;
  if (!doc?.rpc) throw new Error(`rpc.yaml: 'rpc' 키를 찾을 수 없음 (${path})`);
  _config = {
    rpc: doc.rpc as Record<Chain, string[]>,
    freshness: doc.freshness ?? { fresh_max_hours: 26, stale_max_hours: 72 },
  };
  return _config;
}

// 체인 × 엔드포인트별 viem client 캐시
const clientCache = new Map<string, PublicClient>();

function getClient(chain: Chain, url: string): PublicClient {
  const key = `${chain}::${url}`;
  let client = clientCache.get(key);
  if (!client) {
    client = createPublicClient({
      transport: http(url, { timeout: 12_000, retryCount: 0 }),
    });
    clientCache.set(key, client);
  }
  return client;
}

export interface CallOptions {
  /** 실패해도 조용히 넘길지. false면 에러 throw. */
  quiet?: boolean;
}

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export class AllRpcFailedError extends Error {
  constructor(
    public readonly chain: Chain,
    public readonly attempts: { url: string; error: string }[],
  ) {
    super(
      `[${chain}] 모든 RPC 엔드포인트 실패 (${attempts.length}개): ` +
        attempts.map((a) => `${short(a.url)}=${a.error}`).join(", "),
    );
    this.name = "AllRpcFailedError";
  }
}

/**
 * 체인의 RPC 엔드포인트 배열을 순차 fallback 하며 단일 view 함수를 호출한다.
 * 한 엔드포인트가 실패/타임아웃/rate-limit이면 다음으로. 전부 실패하면 AllRpcFailedError.
 */
export async function callWithFallback<T = unknown>(
  chain: Chain,
  call: ContractCall,
  opts: CallOptions = {},
): Promise<T> {
  const cfg = loadRpcConfig();
  const urls = cfg.rpc[chain];
  if (!urls || urls.length === 0) {
    throw new Error(`rpc.yaml: chain '${chain}' 엔드포인트 없음`);
  }

  const attempts: { url: string; error: string }[] = [];
  for (const url of urls) {
    try {
      const client = getClient(chain, url);
      const result = (await client.readContract({
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args as never,
      })) as T;
      return result;
    } catch (err) {
      const msg = errMsg(err);
      attempts.push({ url, error: msg });
      if (!opts.quiet) {
        console.warn(`[rpc] ${chain} ${short(url)} 실패 → 다음 fallback: ${msg}`);
      }
    }
  }

  throw new AllRpcFailedError(chain, attempts);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    // viem 에러 메시지는 장황함 — 첫 줄만.
    return err.message.split("\n")[0].slice(0, 160);
  }
  return String(err).slice(0, 160);
}

function short(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
