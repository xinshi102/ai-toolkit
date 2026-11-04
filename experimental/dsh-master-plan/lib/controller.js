/**
 * @local/dsh-master-plan — CONTROLLER.
 *
 * The only path through which the Master Plan may change. It owns the
 * authoritative in-memory state, serializes every mutation, applies the pure
 * transitions from `state.js`, appends to the Mutation Log and persists before
 * returning. Callers (tools today, any other transport later) never touch the
 * model or the store directly.
 *
 * Separation: STATE decides what is legal, CONTROLLER decides when it happens
 * and makes it durable, VIEW only renders.
 */

import { addTask, buildViewModel, initialState, normalizeState, removeTask, setCurrent, setProject, summarize, updateTask } from "./state.js";
import { createStore, defaultRoot } from "./store.js";

/**
 * Create the controller for one Master Plan document.
 *
 * @param options.root - state directory (defaults to `$DSH_HOME/master-plan`).
 * @param options.logger - optional Cordis logger.
 * @param options.now - clock returning an ISO string (tests).
 * @param options.store - pre-built store (tests).
 */
export function createController(options = {}) {
  const logger = options.logger;
  const env = options.now === undefined ? {} : { now: options.now };
  const store = options.store ?? createStore({ root: options.root ?? defaultRoot(), logger });

  /** Authoritative state; `null` until the first access loads it. */
  let state = null;
  /** Serializes load→mutate→persist so concurrent callers cannot interleave. */
  let queue = Promise.resolve();

  async function load() {
    if (state !== null) return state;
    const loaded = await store.load();
    state = loaded?.version === undefined ? normalizeState(loaded) : loaded;
    return state;
  }

  /** Run `fn` exclusively against the latest state. */
  function exclusive(fn) {
    const run = queue.then(async () => {
      await load();
      return fn();
    });
    // Keep the chain alive even when one mutation rejects.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Apply one pure transition and persist the result.
   *
   * A transition that reports `{ok:false}` is rejected WITHOUT touching disk,
   * so an invalid request can never leave a partial write behind.
   */
  async function apply(label, transition, input, context = {}) {
    return exclusive(async () => {
      const before = state;
      const result = transition(before, { ...input, actor: context.actor ?? "agent" }, env);
      if (!result.ok) {
        logger?.debug?.(`master-plan: rejected ${label}: ${result.error}`);
        return { ok: false, error: result.error, op: label };
      }
      state = result.state;
      try {
        await store.save(state);
      } catch (error) {
        // Keep memory and disk consistent: roll back to the last durable state.
        state = before;
        logger?.error?.(`master-plan: failed to persist ${label}: ${String(error)}`);
        return { ok: false, error: `could not persist plan state: ${String(error)}`, op: label };
      }
      const out = { ok: true, op: label };
      if (result.id !== undefined) out.id = result.id;
      if (result.lifted !== undefined) out.lifted = result.lifted;
      if (result.changed !== undefined) out.changed = result.changed;
      return out;
    });
  }

  return {
    /** Whole authoritative state (read-only by convention). */
    read: () => exclusive(async () => state),
    /** Fully-resolved presentation view model — what the View renders. */
    view: (viewOptions) => exclusive(async () => buildViewModel(state, viewOptions)),
    /** Dense ASCII summary — what the model reads. */
    summary: () => exclusive(async () => summarize(state)),
    /** Recent Mutation Log entries, newest last. */
    log: (limit) =>
      exclusive(async () => {
        const n = Number.isInteger(limit) && limit > 0 ? limit : 20;
        return state.mutationLog.slice(-n);
      }),

    setProject: (input, context) => apply("project", setProject, input, context),
    addTask: (input, context) => apply("task.add", addTask, input, context),
    updateTask: (input, context) => apply("task.update", updateTask, input, context),
    removeTask: (input, context) => apply("task.remove", removeTask, input, context),
    setCurrent: (input, context) => apply("current.set", setCurrent, input, context),

    /** Test seam: forget the in-memory copy so the next call re-reads disk. */
    reload: () =>
      exclusive(async () => {
        state = null;
        await load();
        return state;
      }),

    /** Resolved storage paths, for diagnostics. */
    paths: () => ({ root: store.root, file: store.file }),

    /** Seed an in-memory state without touching disk (tests). */
    _seed: (raw) => {
      state = raw === null ? null : normalizeState(raw);
    },
    initialState,
  };
}
