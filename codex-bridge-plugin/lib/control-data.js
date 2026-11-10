import { open, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";

const validId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
async function readBounded(root, relative, limit) {
  const base = await realpath(root);
  const filename = await realpath(path.resolve(root, relative));
  if (!inside(base, filename)) throw new Error("PATH_OUTSIDE_ROOT");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("FILE_TOO_LARGE_OR_INVALID");
    // Read through the checked descriptor, with a hard allocation bound even if it grows.
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("FILE_TOO_LARGE_OR_INVALID");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
const readJson = async (root, name, limit) => JSON.parse(await readBounded(root, name, limit));

export async function collaborationControl(config = {}) {
  const home = config.collaborationHome || path.join(os.homedir(), "Library/Application Support/xinshi-collaboration");
  let registry;
  try { registry = await readJson(home, "control.json", 64 * 1024); }
  catch (error) {
    if (error.code === "ENOENT") return { ok: true, available: false, runs: [], plan: null };
    return { ok: false, available: false, error: error.message, runs: [], plan: null };
  }
  const errors = [];
  if (registry.schemaVersion !== 1 || !validId(registry.activePlanId) || !Array.isArray(registry.allowedPlanIds) || !registry.allowedPlanIds.includes(registry.activePlanId)) {
    return { ok: false, available: false, error: "UNREGISTERED_PLAN", runs: [], plan: null };
  }
  let plan = null;
  try {
    if (typeof registry.planMapHome !== "string" || !path.isAbsolute(registry.planMapHome)) throw new Error("INVALID_PLAN_HOME");
    const raw = await readJson(registry.planMapHome, registry.activePlanId + ".json", 1024 * 1024);
    if (raw.planId !== registry.activePlanId) throw new Error("PLAN_ID_MISMATCH");
    plan = raw;
  } catch (error) { errors.push({ source: "plan", error: error.message }); }
  const runs = [];
  try {
    // Reject a symlinked runs directory pointing outside the registered home.
    const base = await realpath(home), runRoot = await realpath(path.join(home, "runs"));
    if (!inside(base, runRoot)) throw new Error("PATH_OUTSIDE_ROOT");
    const names = (await readdir(runRoot, { withFileTypes: true })).filter(row => validId(row.name) && (row.isDirectory() || row.isSymbolicLink())).map(row => row.name);
    const candidates = [];
    for (const id of names) {
      try {
        const run = await readJson(home, path.join("runs", id, "run.json"), 512 * 1024);
        if (run.runId !== id) throw new Error("RUN_ID_MISMATCH");
        if (run.planId !== registry.activePlanId) continue;
        candidates.push(run);
      } catch (error) { errors.push({ source: "run", runId: id, error: error.message }); }
    }
    candidates.sort((a,b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    for (const run of candidates.slice(0,30)) {
      let events = [];
      try { events = (await readBounded(home, path.join("runs",run.runId,"events.jsonl"), 2 * 1024 * 1024)).split(/\r?\n/).filter(Boolean).slice(-100).map(line => JSON.parse(line)); }
      catch(error) { if(error.code !== "ENOENT") errors.push({source:"events",runId:run.runId,error:error.message}); }
      runs.push({...run,events});
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push({ source: "runs", error: error.message }); }
  const goals = [];
  try {
    const base = await realpath(home), goalRoot = await realpath(path.join(home, "goals"));
    if (!inside(base, goalRoot)) throw new Error("PATH_OUTSIDE_ROOT");
    const names = (await readdir(goalRoot, { withFileTypes: true })).filter(row => validId(row.name) && row.isDirectory()).map(row => row.name);
    for (const id of names.slice(0, 50)) {
      const goal = await readJson(home, path.join("goals", id, "goal.json"), 256 * 1024);
      if (goal.runId !== id) continue;
      goals.push({ runId: goal.runId, goalId: goal.goalId, objective: goal.objective, status: goal.status,
                   attempts: (goal.attempts || []).length, cost: goal.cost || null,
                   wake: goal.wake || null, progress: goal.progress || null, source: goal.source || "goal-runner",
                   decisionAnswer: goal.decisionAnswer || null, batchId: goal.batchId || null,
                   batchIndex: goal.batchIndex || null, batchSize: goal.batchSize || null,
                   updatedAt: goal.updatedAt || goal.startedAt || "" });
    }
    goals.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  } catch (error) { if (error.code !== "ENOENT") errors.push({ source: "goals", error: error.message }); }
  return { ok: errors.length === 0, available: true, activePlanId: registry.activePlanId, policy: registry.policy || {}, plan, runs, goals, errors };
}
