// 저장 계층 인터페이스 (명세 8장 승격 경로)
// store_json / store_sheet / store_sqlite / store_lakehouse 가 이 인터페이스를 구현.
import type { AssetSnapshot } from "./types.js";

export interface StoreResult {
  appended: number; // 새로 저장된 스냅샷 수
  skipped: number; // 이미 존재해서 스킵한 수 (멱등)
}

export interface SnapshotStore {
  /** (oracle_id, round_id) 자연 키로 멱등 저장. 이미 있으면 스킵. */
  append(snapshots: AssetSnapshot[]): Promise<StoreResult>;
}
