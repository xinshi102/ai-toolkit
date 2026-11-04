/**
 * @local/dsh-master-plan — CONTROLLER transport (host HTTP route).
 *
 * The View runs in the browser and cannot read the state file, so the host
 * exposes the plan on the same origin the Web app is already served from. This
 * is a transport only: reads return the State layer's view model, and writes go
 * through the Controller, so the browser can never mutate the plan by any path
 * the tools do not use.
 *
 * Loopback-only, like every other local route in this deployment.
 */

const PREFIX = "/master-plan";
const MAX_BODY = 64 * 1024;

/** Operations the View is allowed to request. */
const WRITE_OPS = new Set(["task.add", "task.update", "task.remove", "current.set", "project"]);

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Reject anything that is not a loopback caller. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Register the Master Plan route on the host web server.
 *
 * @param ctx - Cordis context providing `webServer` and `logger`.
 * @param controller - the Master Plan controller.
 * @param options.logTail - Mutation Log entries included in the view model.
 * @returns the route disposer.
 */
export function registerRoute(ctx, controller, options = {}) {
  const logTail = Number.isInteger(options.logTail) ? options.logTail : 8;

  const view = () => controller.view({ logTail });

  return ctx.webServer.register({
    kind: "prefix",
    path: PREFIX,
    async handler(req, res) {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      try {
        if (req.method === "GET" && pathname === `${PREFIX}/state`) {
          return json(res, 200, { ok: true, data: await view() });
        }
        if (req.method === "GET" && pathname === `${PREFIX}/health`) {
          const paths = controller.paths();
          return json(res, 200, { ok: true, file: paths.file });
        }
        if (req.method === "POST" && pathname === `${PREFIX}/mutate`) {
          if (!isLoopback(req)) return json(res, 403, { ok: false, error: "LOCAL_ONLY" });
          const raw = await readBody(req);
          let payload;
          try {
            payload = JSON.parse(raw === "" ? "{}" : raw);
          } catch {
            return json(res, 400, { ok: false, error: "INVALID_JSON" });
          }
          const op = payload?.op;
          if (typeof op !== "string" || !WRITE_OPS.has(op)) {
            return json(res, 400, { ok: false, error: `op must be one of ${[...WRITE_OPS].join("|")}` });
          }
          const input = payload?.input ?? {};
          const result = await dispatch(controller, op, input);
          if (!result.ok) return json(res, 400, { ok: false, error: result.error });
          return json(res, 200, { ok: true, data: await view(), result });
        }
        return json(res, 404, { ok: false, error: "NOT_FOUND" });
      } catch (error) {
        if (error?.message === "BODY_TOO_LARGE") return json(res, 413, { ok: false, error: "BODY_TOO_LARGE" });
        ctx.logger?.warn?.(`master-plan: route failed: ${String(error)}`);
        return json(res, 500, { ok: false, error: "INTERNAL" });
      }
    },
  });
}

/** Route one View write to the Controller. `actor` is always `user` here. */
function dispatch(controller, op, input) {
  const context = { actor: "user" };
  switch (op) {
    case "project":
      return controller.setProject({ name: input.name }, context);
    case "task.add":
      return controller.addTask(input, context);
    case "task.update":
      return controller.updateTask(input, context);
    case "task.remove":
      return controller.removeTask(input, context);
    case "current.set":
      return controller.setCurrent({ id: input.id ?? "" }, context);
    default:
      return Promise.resolve({ ok: false, error: `unsupported op "${op}"` });
  }
}
