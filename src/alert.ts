// 알림 (명세 Phase 3, 태스크 3). analysis.json의 무결성 위반을 Slack webhook으로 통지.
// webhook 미설정 시 콘솔 출력만(no-op). GitHub Actions에서 --strict로 실패 step 노출 가능.
//
// 사용: npm run alert            (webhook 있으면 전송, 없으면 로그)
//       npm run alert -- --strict (위반 있으면 exit 1)
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnv } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ANALYSIS_PATH = resolve(ROOT, "data/analysis.json");

export interface Alert {
  severity: "warn" | "critical";
  oracle_id: string;
  message: string;
}

interface AnalysisShape {
  generated_at: string;
  integrity_gate: {
    flagged: { oracle_id: string; reason: string }[];
    cross_chain_divergence: { ticker: string; max_divergence_pct: number }[];
  };
}

/** analysis.json → Alert[] (순수, 테스트 대상). */
export function deriveAlerts(analysis: AnalysisShape): Alert[] {
  const alerts: Alert[] = [];
  for (const f of analysis.integrity_gate.flagged) {
    alerts.push({
      severity: f.reason === "freshness=expired" || f.reason === "custody=failed" ? "critical" : "warn",
      oracle_id: f.oracle_id,
      message: `${f.oracle_id}: ${f.reason}`,
    });
  }
  for (const c of analysis.integrity_gate.cross_chain_divergence) {
    alerts.push({
      severity: "warn",
      oracle_id: c.ticker,
      message: `${c.ticker} 교차체인 NAV 발산 ${c.max_divergence_pct}%`,
    });
  }
  return alerts;
}

function formatSlack(alerts: Alert[], generatedAt: string): object {
  const lines = alerts.map(
    (a) => `${a.severity === "critical" ? "🔴" : "🟡"} ${a.message}`,
  );
  return {
    text:
      `*Chronicle PoA 무결성 알림* (${generatedAt})\n` +
      `${alerts.length}건 위반:\n` +
      lines.join("\n"),
  };
}

async function sendSlack(webhook: string, payload: object): Promise<boolean> {
  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function main() {
  loadEnv();
  const strict = process.argv.includes("--strict");
  if (!existsSync(ANALYSIS_PATH)) {
    console.error(`analysis.json 없음 — 먼저 npm run analyze 하세요.`);
    process.exit(1);
  }
  const analysis = JSON.parse(readFileSync(ANALYSIS_PATH, "utf8")) as AnalysisShape;
  const alerts = deriveAlerts(analysis);

  if (alerts.length === 0) {
    console.log("✅ 무결성 위반 없음 — 알림 없음.");
    return;
  }

  console.log(`⚠️  무결성 위반 ${alerts.length}건:`);
  for (const a of alerts) console.log(`   ${a.severity === "critical" ? "🔴" : "🟡"} ${a.message}`);

  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (webhook) {
    const ok = await sendSlack(webhook, formatSlack(alerts, analysis.generated_at));
    console.log(ok ? "\n→ Slack 전송 완료" : "\n→ Slack 전송 실패");
  } else {
    console.log("\n(SLACK_WEBHOOK_URL 미설정 — 전송 생략, 로그만)");
  }

  if (strict) process.exit(1); // Actions에서 실패 step으로 노출
}

// 직접 실행일 때만 (import 시 실행 안 됨)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("알림 실패:", err);
    process.exit(1);
  });
}
