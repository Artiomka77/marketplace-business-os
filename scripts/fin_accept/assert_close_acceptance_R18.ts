/**
 * Close-acceptance gate for FIN_CLOSE C01 / R18.
 * READY only when G1–G6 are all VERIFIED with real evidence content.
 *
 *   node --import tsx scripts/fin_accept/assert_close_acceptance_R18.ts \
 *     path/to/CLOSE_ACCEPTANCE.json [path/to/isolation_out]
 *
 * Exit 0 = READY_FOR_DEPLOY allowed by evidence.
 * Exit 1 = not ready. Always writes ASSERT_REPORT.json beside input.
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

function resolveEvidence(rel: string): string | null {
  if (!isoDir) return null;
  const p = path.isAbsolute(rel) ? rel : path.join(isoDir, rel);
  return fs.existsSync(p) ? p : null;
}

function nonEmptyFile(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

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
  } else if (isoDir) {
    // Evidence paths must exist and have content when isolation_out is provided.
    let okFiles = 0;
    for (const ev of g.evidence) {
      const resolved = resolveEvidence(String(ev));
      if (!resolved) {
        reasons.push(`GATE_EVIDENCE_MISSING ${id} path=${ev}`);
        continue;
      }
      if (fs.statSync(resolved).isDirectory()) {
        const kids = fs.readdirSync(resolved);
        if (kids.length === 0) {
          reasons.push(`GATE_EVIDENCE_EMPTY_DIR ${id} path=${ev}`);
        } else {
          okFiles += 1;
        }
        continue;
      }
      if (!nonEmptyFile(resolved)) {
        reasons.push(`GATE_EVIDENCE_EMPTY ${id} path=${ev}`);
      } else {
        okFiles += 1;
      }
    }
    if (okFiles === 0) {
      reasons.push(`GATE_NO_REAL_EVIDENCE ${id}`);
    }
  }
}

if (isoDir && fs.existsSync(isoDir)) {
  const logsDir = path.join(isoDir, "logs");
  const sqlForce = path.join(logsDir, "sql_force_success.txt");
  if (fs.existsSync(sqlForce)) {
    reasons.push("G3_DISQUALIFIED sql_force_success artifact present");
  }

  const g3 = byId.get("G3");
  if (g3 && g3.status === "VERIFIED") {
    // Contract-only G4 fixture marker must NOT disqualify a real G3 run.
    // Only an explicit "fixture used for G3 verified path" marker does.
    const g3FixtureCheat = path.join(logsDir, "g3_used_fixture_for_verified_path.txt");
    if (fs.existsSync(g3FixtureCheat)) {
      reasons.push(
        "G3_DISQUALIFIED fixture compute / canonical sum substitution on verified path",
      );
    }
    const primaryLoaded = path.join(logsDir, "load_primary.txt");
    if (!fs.existsSync(primaryLoaded) || !nonEmptyFile(primaryLoaded)) {
      reasons.push("G3_DISQUALIFIED missing load_primary.txt (primary stand required)");
    } else {
      const txt = fs.readFileSync(primaryLoaded, "utf8");
      if (!txt.includes("LOAD_PRIMARY_STAND_C01_OK")) {
        reasons.push("G3_DISQUALIFIED load_primary.txt without LOAD_PRIMARY_STAND_C01_OK");
      }
    }
    const enqueue = path.join(logsDir, "enqueue_profit.txt");
    const realWorker = path.join(logsDir, "real_worker_profit.txt");
    const realV6 = path.join(logsDir, "real_worker_v6.txt");
    const realDash = path.join(logsDir, "real_worker_dashboard.txt");
    const verifyReal = path.join(logsDir, "verify_hit_real.txt");
    const g3status = path.join(logsDir, "g3_status.txt");
    for (const [label, p] of [
      ["enqueue_profit.txt", enqueue],
      ["real_worker_profit.txt", realWorker],
      ["real_worker_v6.txt", realV6],
      ["real_worker_dashboard.txt", realDash],
      ["verify_hit_real.txt", verifyReal],
      ["g3_status.txt", g3status],
    ] as const) {
      if (!fs.existsSync(p) || !nonEmptyFile(p)) {
        reasons.push(`G3_DISQUALIFIED missing/empty ${label}`);
      }
    }
    if (fs.existsSync(g3status)) {
      const st = fs.readFileSync(g3status, "utf8");
      if (!/g3_status=VERIFIED/.test(st)) {
        reasons.push("G3_DISQUALIFIED g3_status.txt is not VERIFIED");
      }
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

  // Without isoDir, READY cannot be claimed on evidence names alone when caller
  // passed readyForDeploy — still require isoDir for a true READY verdict.
}

if (!isoDir) {
  // Refuse READY when no isolation root was provided for evidence checks.
  if (doc.readyForDeploy === true || reasons.length === 0) {
    // If all gates claim VERIFIED but we cannot verify files, block READY.
    const allClaim =
      REQUIRED.every((id) => ACCEPT.has(String(byId.get(id)?.status))) &&
      REQUIRED.every((id) => (byId.get(id)?.evidence?.length ?? 0) > 0);
    if (allClaim) {
      reasons.push("ISO_DIR_REQUIRED_FOR_READY — evidence paths not verified");
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
  isoDirProvided: Boolean(isoDir),
};
const outPath = path.join(path.dirname(file), "ASSERT_REPORT.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (!ready) {
  console.error("CLOSE_ACCEPTANCE_NOT_READY");
  process.exit(1);
}
console.log("CLOSE_ACCEPTANCE_READY_FOR_DEPLOY");
