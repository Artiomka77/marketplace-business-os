/**
 * Close-acceptance gate for FIN_CLOSE C01 / R18.
 * READY only when G1–G6 are all VERIFIED with non-empty evidence.
 * Refuses SQL-SUCCESS worker substitution and missing mandatory gates.
 *
 *   node --import tsx scripts/fin_accept/assert_close_acceptance_R18.ts \
 *     path/to/CLOSE_ACCEPTANCE.json [path/to/isolation_out]
 *
 * Exit 0 = READY_FOR_DEPLOY allowed by evidence.
 * Exit 1 = not ready (print reasons). Always writes ASSERT_REPORT.json beside input.
 */
import fs from "node:fs";
import path from "node:path";

const REQUIRED = ["G1", "G2", "G3", "G4", "G5", "G6"] as const;
const ACCEPT = new Set(["VERIFIED"]);

type Gate = {
  id: string;
  description?: string;
  status: string;
  evidence?: string[];
  proofType?: string;
};

type Doc = {
  gates?: Gate[];
  productionChanged?: boolean;
  telegramSent?: boolean;
  deploymentStatus?: string;
  readyForDeploy?: boolean;
};

const file = process.argv[2];
const isoDir = process.argv[3];
if (!file) {
  console.error("usage: assert_close_acceptance_R18.ts CLOSE_ACCEPTANCE.json [isolation_out]");
  process.exit(2);
}

const doc = JSON.parse(fs.readFileSync(file, "utf8")) as Doc;
const reasons: string[] = [];
const gates = doc.gates || [];
const byId = new Map(gates.map((g) => [g.id, g]));

for (const id of REQUIRED) {
  const g = byId.get(id);
  if (!g) {
    reasons.push(`MISSING_GATE ${id}`);
    continue;
  }
  if (!ACCEPT.has(String(g.status))) {
    reasons.push(`GATE_NOT_VERIFIED ${id} status=${g.status}`);
  }
  if (!Array.isArray(g.evidence) || g.evidence.length === 0) {
    reasons.push(`GATE_NO_EVIDENCE ${id}`);
  }
}

// Disqualify G3 if isolation logs show SQL SUCCESS substitution on positive path
if (isoDir && fs.existsSync(isoDir)) {
  const logsDir = path.join(isoDir, "logs");
  const drain = path.join(logsDir, "drain_profit.txt");
  const enqueue = path.join(logsDir, "enqueue_profit.txt");
  const sqlForce = path.join(logsDir, "sql_force_success.txt");
  if (fs.existsSync(sqlForce)) {
    reasons.push("G3_DISQUALIFIED sql_force_success artifact present");
  }
  const g3 = byId.get("G3");
  if (g3 && g3.status === "VERIFIED") {
    const fixtureMarker = path.join(logsDir, "g3_used_fixture_compute.txt");
    if (fs.existsSync(fixtureMarker)) {
      reasons.push(
        "G3_DISQUALIFIED fixture compute / canonical sum substitution while status=VERIFIED",
      );
    }
    if (!fs.existsSync(enqueue)) {
      reasons.push("G3_DISQUALIFIED missing enqueue_profit.txt evidence");
    }
    const realWorkerLog = path.join(logsDir, "real_worker_profit.txt");
    if (!fs.existsSync(realWorkerLog)) {
      reasons.push("G3_DISQUALIFIED missing real_worker_profit.txt");
    }
    if (g3.proofType === "fixture_compute" || g3.proofType === "sql_success") {
      reasons.push(`G3_DISQUALIFIED proofType=${g3.proofType}`);
    }
    if (g3.proofType !== "real_worker_scripts") {
      reasons.push(
        `G3_DISQUALIFIED proofType=${g3.proofType ?? "unset"} (need real_worker_scripts)`,
      );
    }
  }
}

if (doc.readyForDeploy === true && reasons.length > 0) {
  reasons.push("READY_FLAG_SET_WHILE_GATES_INCOMPLETE");
}

const ready = reasons.length === 0;
const report = {
  readyForDeploy: ready,
  reasons,
  gates: REQUIRED.map((id) => {
    const g = byId.get(id);
    return {
      id,
      status: g?.status ?? "MISSING",
      evidenceCount: g?.evidence?.length ?? 0,
      proofType: g?.proofType ?? null,
    };
  }),
  productionChanged: doc.productionChanged === true,
  telegramSent: doc.telegramSent === true,
};
const outPath = path.join(path.dirname(file), "ASSERT_REPORT.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!ready) {
  console.error("CLOSE_ACCEPTANCE_NOT_READY");
  process.exit(1);
}
console.log("CLOSE_ACCEPTANCE_READY_FOR_DEPLOY");
