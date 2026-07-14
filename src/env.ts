// 최소 .env 로더 (의존성 없이). 프로젝트 루트의 .env 를 process.env 에 주입.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let loaded = false;

export function loadEnv(path = resolve(ROOT, ".env")): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // 따옴표 제거
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function requireEnv(key: string): string {
  loadEnv();
  const v = process.env[key];
  if (!v) throw new Error(`환경변수 ${key} 없음 (.env 확인)`);
  return v;
}
