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
    // Positive verify outcome required (not merely a non-empty file)
    const verifyJsonPath = path.join(isoDir, "verify_hit_real.json");
    if (fs.existsSync(verifyReal)) {
      const vtxt = fs.readFileSync(verifyReal, "utf8");
      if (
        /VERIFY_WEEK_CONSUMER_.*FAIL|verify_hit_real_exit=1/.test(vtxt) ||
        !/VERIFY_WEEK_CONSUMER_.*PASS|verify_hit_real_exit=0/.test(vtxt)
      ) {
        reasons.push("G3_DISQUALIFIED verify_hit_real.txt is not PASS");
      }
    }
    if (fs.existsSync(verifyJsonPath)) {
      try {
        const vj = JSON.parse(fs.readFileSync(verifyJsonPath, "utf8")) as {
          ok?: boolean;
          failures?: unknown[];
        };
        if (vj.ok !== true) {
          reasons.push("G3_DISQUALIFIED verify_hit_real.json ok!==true");
        }
        if (Array.isArray(vj.failures) && vj.failures.length > 0) {
          reasons.push("G3_DISQUALIFIED verify_hit_real.json has failures");
        }
      } catch {
        reasons.push("G3_DISQUALIFIED verify_hit_real.json unreadable");
      }
    } else {
      reasons.push("G3_DISQUALIFIED missing verify_hit_real.json");
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

  // G2: full MAIN evidence — refuse STOP_AFTER-as-MAIN_OK and failed recovery marked OK
  const g2 = byId.get("G2");
  if (g2 && g2.status === "VERIFIED") {
    const runOk = path.join(logsDir, "run_all_real_backup_ok.txt");
    const runFail = path.join(logsDir, "run_all_backup_fail.txt");
    const runFull = path.join(logsDir, "run_all_full_ok.txt");
    if (fs.existsSync(runOk)) {
      const t = fs.readFileSync(runOk, "utf8");
      if (/RUN_ALL_STOP_AFTER=/.test(t) && /RUN_ALL_MAIN_OK/.test(t)) {
        reasons.push(
          "G2_DISQUALIFIED RUN_ALL_STOP_AFTER combined with RUN_ALL_MAIN_OK (partial is not full MAIN)",
        );
      }
      if (/RUN_ALL_PARTIAL_OK/.test(t) && !fs.existsSync(runFull)) {
        reasons.push(
          "G2_DISQUALIFIED only PARTIAL run-all present — need run_all_full_ok.txt with switch/weekly/verify",
        );
      }
    }
    if (fs.existsSync(runFail)) {
      const t = fs.readFileSync(runFail, "utf8");
      if (
        /AND recovery failed|FATAL:.*recovery failed|FATAL: recovered container not Running/.test(
          t,
        ) &&
        /RUN_ALL_BACKUP_FAIL_RECOVERY_OK/.test(t)
      ) {
        reasons.push(
          "G2_DISQUALIFIED RUN_ALL_BACKUP_FAIL_RECOVERY_OK stamped over failed recovery",
        );
      }
    }
    if (fs.existsSync(runFull)) {
      const t = fs.readFileSync(runFull, "utf8");
      if (!/RUN_ALL_MAIN_OK/.test(t)) {
        reasons.push("G2_DISQUALIFIED run_all_full_ok.txt missing RUN_ALL_MAIN_OK");
      }
      if (/RUN_ALL_STOP_AFTER=/.test(t)) {
        reasons.push("G2_DISQUALIFIED full MAIN log still has RUN_ALL_STOP_AFTER");
      }
      if (!/RUN_ALL_STEP switch|SWITCH_OK|SWITCH_CALLED/.test(t)) {
        reasons.push("G2_DISQUALIFIED full MAIN missing switch step");
      }
      if (!/RUN_ALL_STEP weekly|WEEKLY_ENQUEUE_AND_WAIT_OK|WEEKLY_CALLED/.test(t)) {
        reasons.push("G2_DISQUALIFIED full MAIN missing weekly step");
      }
      if (!/RUN_ALL_STEP verify-week|VERIFY_WEEK|VERIFY_CALLED/.test(t)) {
        reasons.push("G2_DISQUALIFIED full MAIN missing verify-week step");
      }
    } else if (g2.status === "VERIFIED") {
      reasons.push("G2_DISQUALIFIED missing run_all_full_ok.txt (complete MAIN required)");
    }
  }

  const g4 = byId.get("G4");
  if (g4 && g4.status === "VERIFIED") {
    const verifyAfter = path.join(logsDir, "verify_after_restore.txt");
    const restorePcm = path.join(logsDir, "restore_v6_pcm.txt");
    if (!fs.existsSync(verifyAfter) || !nonEmptyFile(verifyAfter)) {
      reasons.push("G4_DISQUALIFIED missing verify_after_restore.txt");
    } else {
      const t = fs.readFileSync(verifyAfter, "utf8");
      if (
        /VERIFY_WEEK_CONSUMER_.*FAIL|verify_after_restore_exit=1/.test(t) ||
        !/VERIFY_WEEK_CONSUMER_.*PASS|verify_after_restore_exit=0/.test(t)
      ) {
        reasons.push("G4_DISQUALIFIED verify_after_restore is not PASS");
      }
    }
    if (!fs.existsSync(restorePcm) || !nonEmptyFile(restorePcm)) {
      reasons.push("G4_DISQUALIFIED missing restore_v6_pcm.txt (PeriodCompanyMarketplaceMetric)");
    } else {
      const t = fs.readFileSync(restorePcm, "utf8");
      if (!/DATA_ROLLBACK_LIVE_R18_OK|pcmRestored/.test(t)) {
        reasons.push("G4_DISQUALIFIED restore_v6_pcm.txt without PCM restore proof");
      }
      if (!/PeriodCompanyMarketplaceMetric|pcm_fingerprint_match|PCM_RESTORE_OK/.test(t)) {
        reasons.push("G4_DISQUALIFIED restore_v6_pcm.txt missing PCM table/fingerprint proof");
      }
    }
  }

  const g5 = byId.get("G5");
  if (g5 && g5.status === "VERIFIED") {
    const tgSum = path.join(isoDir, "telegram/REHEARSAL_SUMMARY.json");
    const tgPlan = path.join(isoDir, "fa_state/telegram_plan.json");
    if (!fs.existsSync(tgSum)) {
      reasons.push("G5_DISQUALIFIED missing telegram/REHEARSAL_SUMMARY.json");
    } else {
      try {
        const s = JSON.parse(fs.readFileSync(tgSum, "utf8")) as {
          ok?: boolean;
          mockUsed?: boolean;
          stubServer?: boolean;
          dailyReportRouteOk?: boolean;
          webhookRouteOk?: boolean;
          autoRecoveryOnBadHealth?: boolean;
          imageIdObserved?: string;
          oldImageId?: string;
          planJson?: string | null;
          planExecuted?: boolean;
          financeAllRounded?: number;
        };
        if (s.ok !== true) reasons.push("G5_DISQUALIFIED REHEARSAL_SUMMARY ok!==true");
        if (s.mockUsed === true) reasons.push("G5_DISQUALIFIED mockUsed=true");
        if (s.stubServer === true) {
          reasons.push("G5_DISQUALIFIED stubServer=true (HTTP stub is not Telegram app)");
        }
        if (s.webhookRouteOk !== true) {
          reasons.push("G5_DISQUALIFIED webhookRouteOk!==true");
        }
        if (s.dailyReportRouteOk !== true) {
          reasons.push("G5_DISQUALIFIED dailyReportRouteOk!==true");
        }
        if (s.autoRecoveryOnBadHealth !== true) {
          reasons.push("G5_DISQUALIFIED autoRecoveryOnBadHealth!==true");
        }
        if (
          !s.imageIdObserved ||
          String(s.imageIdObserved).includes("1bb80d6b") ||
          String(s.imageIdObserved).includes("deadbeef") ||
          String(s.imageIdObserved).includes("6c90e310")
        ) {
          reasons.push("G5_DISQUALIFIED stub/forbidden ImageId");
        }
        if (
          !s.oldImageId ||
          String(s.oldImageId).includes("6c90e310") ||
          String(s.oldImageId) === String(s.imageIdObserved)
        ) {
          reasons.push(
            "G5_DISQUALIFIED OLD must be real prior runtime (7f9fee6a…), not helper stub",
          );
        }
        if (!s.planJson) {
          reasons.push("G5_DISQUALIFIED planJson=null — plan must bind to rehearsal");
        }
        if (s.planExecuted !== true) {
          reasons.push("G5_DISQUALIFIED planExecuted!==true");
        }
        if (s.financeAllRounded != null && s.financeAllRounded !== 994198.47) {
          reasons.push(
            `G5_DISQUALIFIED financeAllRounded=${s.financeAllRounded} want 994198.47`,
          );
        }
      } catch {
        reasons.push("G5_DISQUALIFIED REHEARSAL_SUMMARY unreadable");
      }
    }
    if (!fs.existsSync(tgPlan)) {
      reasons.push("G5_DISQUALIFIED missing fa_state/telegram_plan.json");
    } else {
      try {
        const p = JSON.parse(fs.readFileSync(tgPlan, "utf8")) as {
          telegramReady?: boolean;
          commands_update_AFTER_MAIN_VERIFY?: string[];
          commands_rollback?: string[];
          scriptsCommit?: string;
        };
        if (p.telegramReady !== true) {
          reasons.push("G5_DISQUALIFIED telegramReady!==true");
        }
        if (
          !Array.isArray(p.commands_update_AFTER_MAIN_VERIFY) ||
          p.commands_update_AFTER_MAIN_VERIFY.length === 0
        ) {
          reasons.push("G5_DISQUALIFIED empty commands_update_AFTER_MAIN_VERIFY");
        }
        if (!Array.isArray(p.commands_rollback) || p.commands_rollback.length === 0) {
          reasons.push("G5_DISQUALIFIED empty commands_rollback");
        }
        if (!p.scriptsCommit || String(p.scriptsCommit).includes("MUST_SET")) {
          reasons.push("G5_DISQUALIFIED scriptsCommit missing/placeholder");
        }
        const cmds = [
          ...(p.commands_update_AFTER_MAIN_VERIFY || []),
          ...(p.commands_rollback || []),
        ].join("\n");
        if (/c01_isolation_local|telegram_health_stub|NEW_TELEGRAM_IMAGE_WITH_ACCEPTED/.test(cmds)) {
          reasons.push("G5_DISQUALIFIED plan still references stub/placeholder image");
        }
        if (!/api\/telegram\/webhook|daily-report/.test(cmds)) {
          reasons.push("G5_DISQUALIFIED plan health must check application routes");
        }
      } catch {
        reasons.push("G5_DISQUALIFIED telegram_plan.json unreadable");
      }
    }
  }
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
