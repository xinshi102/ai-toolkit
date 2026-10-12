/**
 * @local/dsh-master-plan — STATE persistence.
 *
 * The Master Plan is stored as one JSON document outside any conversation, so
 * it survives new sessions, restarts and compaction. Writes are atomic
 * (temp file + `rename`) and a corrupt document is quarantined rather than
 * silently discarded.
 *
 * `state.js` owns the model; this module owns bytes on disk. Nothing here
 * decides what a valid plan is.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initialState, normalizeState } from "./state.js";

/** Default location: `$DSH_HOME/master-plan`, falling back to `~/.dsh`. */
export function defaultRoot(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== "" ? env.DSH_HOME : path.join(os.homedir(), ".dsh");
  return path.join(home, "master-plan");
}

/**
 * One durable document store.
 *
 * @param options.root - directory holding `state.json`.
 * @param options.logger - optional Cordis logger.
 * @returns load/save plus the resolved paths.
 */
export function createStore(options = {}) {
  const root = options.root !== undefined && options.root !== "" ? options.root : defaultRoot();
  const file = path.join(root, "state.json");
  const logger = options.logger;
  let tmpCounter = 0;

  async function load() {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return initialState();
      logger?.warn?.(`master-plan: cannot read ${file}: ${String(error)} — starting from an empty plan`);
      return initialState();
    }
    try {
      return normalizeState(JSON.parse(text));
    } catch (error) {
      // Keep the damaged document so a human can inspect it; never destroy data.
      const quarantine = `${file}.corrupt-${Date.now()}`;
      try {
        await rename(file, quarantine);
        logger?.error?.(`master-plan: ${file} is not valid JSON (${String(error)}); moved to ${quarantine}`);
      } catch (renameError) {
        logger?.error?.(`master-plan: ${file} is not valid JSON and could not be quarantined: ${String(renameError)}`);
      }
      return initialState();
    }
  }

  async function save(state) {
    await mkdir(root, { recursive: true });
    tmpCounter += 1;
    const tmp = `${file}.tmp-${process.pid}-${tmpCounter}`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmp, file);
    return file;
  }

  return { root, file, load, save };
}
