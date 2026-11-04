window.__ModuleLoader__.load({
  id: "@local/dsh-codex-bridge",
  factory: () => {
    const module = { exports: {} };
    function el(tag, text) {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    }
    async function api(path, body) {
      const response = await fetch(`/api/codex-bridge/${path}`, {
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }
    function apply(ctx) {
      const SEEN_KEY = "dsh-codex-bridge-last-seen";
      const BASE_TITLE = document.title.replace(/^●\s*/, "");
      async function openWindow() {
        const response = await fetch("/codex-collab/open-window", { method: "POST" });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
        return value;
      }
      function announce(row) {
        document.title = `● ${BASE_TITLE}`;
        document.getElementById("dsh-codex-bridge-toast")?.remove();
        const toast = el("button", `${row.sender || "DeepSeek"} → Codex 有新消息  ·  打开独立窗口`);
        toast.id = "dsh-codex-bridge-toast";
        toast.type = "button";
        toast.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:12px 16px;border:1px solid rgba(255,255,255,.2);border-radius:14px;background:linear-gradient(135deg,#111827,#1e293b);color:#fff;box-shadow:0 16px 42px rgba(15,23,42,.35);font-size:13px;font-weight:650;cursor:pointer;backdrop-filter:blur(18px)";
        toast.onclick = async (event) => {
          event.stopPropagation();
          try { await openWindow(); } catch {}
          localStorage.setItem(SEEN_KEY, row.timestamp);
          document.title = BASE_TITLE;
          toast.remove();
        };
        document.body.append(toast);
        setTimeout(() => toast.remove(), 15000);
      }
      async function checkIncoming() {
        const state = await api("status");
        const selected = state.sessions.find((item) => item.authorized) || state.sessions.at(-1);
        if (!selected) return;
        const conversation = await api(`messages?sessionId=${encodeURIComponent(selected.id)}`);
        const latest = conversation.messages.filter((row) => row.direction === "deepseek-to-codex").at(-1);
        if (!latest) return;
        const seen = localStorage.getItem(SEEN_KEY);
        if (seen && latest.timestamp > seen) announce(latest);
        else if (!seen) localStorage.setItem(SEEN_KEY, latest.timestamp);
      }
      if (window.__dshCodexBridgeWatcher) clearInterval(window.__dshCodexBridgeWatcher);
      window.__dshCodexBridgeWatcher = setInterval(() => checkIncoming().catch(() => {}), 2500);
      checkIncoming().catch(() => {});

      function mount() {
        if (!window.dshDock) return false;
        document.querySelectorAll('button[aria-label="Codex 协作桥"]').forEach((node) => node.remove());
        window.__dshCodexBridgeDockEntry?.close?.();
        window.__dshCodexBridgeDockEntry = window.dshDock.add({
          icon: "⇄",
          label: "Codex 协作入口",
          render(body) {
            body.style.cssText = "width:228px;min-width:228px;padding:10px";
            const heading = el("div", "DeepSeek ↔ Codex");
            heading.style.cssText = "font-size:13px;font-weight:750;margin:1px 2px 7px";
            const openStandalone = el("button", "打开独立协作窗口");
            const openCodex = el("button", "打开 Codex");
            const status = el("div", "");
            [openStandalone, openCodex].forEach((button) => {
              button.type = "button";
              button.style.cssText = "display:block;width:100%;margin-top:6px;padding:8px 10px;border:0;border-radius:9px;font-size:11px;font-weight:650;cursor:pointer";
            });
            openStandalone.style.cssText += ";background:#2563eb;color:#fff";
            openCodex.style.cssText += ";background:rgba(127,127,127,.14);color:inherit";
            status.style.cssText = "min-height:0;margin:7px 2px 0;font-size:10px;line-height:1.4;opacity:.68";
            openStandalone.onclick = async () => {
              status.textContent = "正在打开…";
              try { await openWindow(); status.textContent = "独立窗口已打开。"; }
              catch (error) { status.textContent = `打开失败：${error.message}`; }
            };
            openCodex.onclick = async () => {
              status.textContent = "正在按系统代理检查网络…";
              try {
                const network = await api("network");
                if (!network.allowed) {
                  status.textContent = network.reason === "CODEX_REGION_NOT_US"
                    ? `出口地区为 ${network.location || "未知"}，已阻止启动 Codex。`
                    : network.reason === "SYSTEM_PROXY_DISABLED"
                      ? "macOS 系统代理未开启；请先启用美国节点的规则模式。"
                      : network.reason === "SYSTEM_PROXY_UNAVAILABLE"
                        ? "无法读取 macOS 系统代理（scutil --proxy）。"
                        : network.reason === "PROXY_CONNECTION_REFUSED"
                          ? "系统代理端口拒绝连接；请检查代理服务与端口。"
                          : network.reason === "PROXY_CONNECTION_TIMEOUT"
                            ? "连接系统代理超时；请检查代理服务与端口。"
                            : network.reason === "REGION_UNVERIFIED"
                              ? "无法确认出口地区，已阻止启动 Codex。"
                              : "代理网络不可用；请检查系统代理地址与端口。";
                  return;
                }
                await api("open-codex", {});
                status.textContent = "网络可用，Codex 已打开。";
              } catch (error) { status.textContent = `打开失败：${error.message}`; }
            };
            body.append(heading, openStandalone, openCodex, status);
          },
        });
        return true;
      }
      if (!mount()) {
        const timer = setInterval(() => { if (mount()) clearInterval(timer); }, 250);
        ctx.effect?.(() => () => clearInterval(timer), "codex-bridge: wait dock");
      }
    }
    module.exports = { name: "@local/dsh-codex-bridge", apply };
    return module.exports;
  },
});
