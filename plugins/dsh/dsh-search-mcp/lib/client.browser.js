/*
 * dsh-search-mcp — browser half.
 *
 * Registers one card into the Settings → Plugins → 插件配置 (configurable) tab,
 * bound to the `search-mcp` settings namespace registered by the host half.
 *
 * The card is a structured form (no raw JSON editing), designed to feel like
 * the neighbor cards:
 *   - 默认服务器: dropdown of the configured server ids (friendly labels)
 *   - 结果数上限 / 搜索超时: numeric inputs (timeout in seconds)
 *   - 常用提供商 quick-add: one-click preset rows (Tavily / Brave / Exa /
 *     Perplexity / DuckDuckGo) — only the API key still needs filling
 *   - 服务器列表: collapsible rows; known providers show only identity,
 *     provider, write-only key/reference status, and result limit; custom rows
 *     additionally expose transport, URL/command, authentication, and tool name.
 *
 * Loaded through window.__ModuleLoader__ like every shipped client bundle.
 */
window.__ModuleLoader__.load({
	id: "dsh-search-mcp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");

		//#region styles
		const css = [
			".smcp_card{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
			".smcp_card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".smcp_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".smcp_headBtn{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".smcp_headBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
			".smcp_head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".smcp_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
			".smcp_desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
			".smcp_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
			".smcp_chevronOpen{transform:rotate(180deg)}",
			".smcp_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px;display:flex;flex-direction:column;gap:0}",
			".smcp_field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
			".smcp_field + .smcp_field{border-top:1px solid var(--dsw-alias-border-l2)}",
			".smcp_label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}",
			".smcp_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
			".smcp_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}",
			".smcp_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".smcp_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 8px;font-size:13px;line-height:1.5}",
			".smcp_select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}",
			".smcp_invalid{border-color:var(--dsw-alias-label-error)}",
			".smcp_error{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}",
			".smcp_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
			".smcp_badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}",
			".smcp_badgeDanger{white-space:nowrap;color:var(--dsw-alias-label-error);border:1px solid var(--dsw-alias-label-error);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}",
			".smcp_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}",
			".smcp_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".smcp_reset:disabled{cursor:default}",
			".smcp_footer{display:flex;justify-content:flex-end;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}",
			".smcp_btn{font:inherit;border-radius:8px;padding:0 14px;height:32px;font-size:13px;line-height:1.5;cursor:pointer}",
			".smcp_btnPrimary{border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand)}",
			".smcp_btnPrimary:disabled{opacity:.5;cursor:default}",
			".smcp_btnGhost{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary)}",
			".smcp_btnGhost:disabled{opacity:.5;cursor:default}",
			".smcp_quickAdd{display:flex;flex-wrap:wrap;gap:8px;padding:2px 0 6px}",
			".smcp_quickBtn{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 12px;font-size:12px;line-height:1.5;cursor:pointer}",
			".smcp_quickBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}",
			".smcp_quickBtn:disabled{opacity:.5;cursor:default}",
			".smcp_row{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-2)}",
			".smcp_rowHead{display:flex;align-items:center;gap:8px;min-width:0}",
			".smcp_rowToggle{appearance:none;border:0;background:0 0;padding:2px;cursor:pointer;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;flex:none;transition:transform .16s}",
			".smcp_rowToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:6px}",
			".smcp_rowToggleOpen{transform:rotate(180deg)}",
			".smcp_kindBadge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;flex:none}",
			".smcp_rowTitle{flex:0 0 auto;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}",
			".smcp_rowSummary{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".smcp_rowBody{border-top:1px dashed var(--dsw-alias-border-l2);margin-top:2px;padding-top:8px;display:flex;flex-direction:column;gap:8px}",
			".smcp_rowId{flex:1;min-width:0}",
			".smcp_rowGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}",
			".smcp_rowGrid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}",
			".smcp_cell{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".smcp_cellLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}",
			".smcp_cellHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}",
			".smcp_add{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;border:1px dashed var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 12px;font-size:12px;line-height:1.5;cursor:pointer}",
			".smcp_add:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}",
			".smcp_del{border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:4px 10px;font-size:12px;line-height:1.5;cursor:pointer;flex:none}",
			".smcp_del:hover{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}"
		].join("");
		const cssTag = "dsh-search-mcp/card.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${cssTag}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-search-mcp";
			tag.dataset.pluginCss = cssTag;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

			//#region provider catalog (browser-side metadata only)
			const CATALOG = {
				tavily: { needsKey: true },
				brave: { needsKey: true },
				exa: { needsKey: true },
				perplexity: { needsKey: true },
				duckduckgo: { needsKey: false },
				custom: { needsKey: false }
			};
			const KIND_OPTIONS = Object.keys(CATALOG);
			const TRANSPORT_OPTIONS = ["http", "stdio"];
			const AUTH_STYLE_OPTIONS = ["", "query", "header"];

		/** Brand labels shown on the kind badge / quick-add buttons. */
		const KIND_LABELS = {
			tavily: "Tavily",
			brave: "Brave",
			exa: "Exa",
			perplexity: "Perplexity",
			duckduckgo: "DuckDuckGo",
			custom: "Custom"
		};
		/** Kinds offered as one-click presets (custom is added via the dashed button). */
		const QUICK_KINDS = ["tavily", "brave", "exa", "perplexity", "duckduckgo"];
		//#endregion

		//#region locale
		const en = {
			title: "Search MCP",
			description: "Search MCP servers behind the web_search tool; the built-in DeepSeek search stays disabled while this plugin is enabled.",
			defaultServer: "Default server",
			defaultServerHint: "Which server row serves searches (empty = first row).",
			maxResults: "Max results",
			maxResultsHint: "Sources returned per search (1–50; empty = default).",
			searchTimeoutMs: "Search timeout (s)",
			searchTimeoutMsHint: "Abort a search that takes longer than this.",
			servers: "Search MCP servers",
				serversHint: "Choose a provider and enter its CDKey/API key. Known providers keep connection details in the host catalog; custom rows expose advanced MCP settings.",
				quickAdd: "Common providers",
				quickAddHint: "Add a provider row, then enter its CDKey/API key before saving. No endpoint is required for known providers.",
			addServer: "Add custom server",
			removeServer: "Delete",
			rowId: "ID",
			rowIdHint: "Stable id used by “default server”.",
			rowKind: "Provider",
			rowTransport: "Transport",
			rowUrl: "Endpoint (URL)",
			rowCommand: "Command",
			rowArgs: "Args (comma separated)",
				rowApiKey: "API key",
				cdKey: "CDKey / API key",
				cdKeyHint: "enter CDKey / API key",
				keyNotRequired: "no key required",

			rowApiKeyEnv: "Key env/credential ref",
			rowAuthStyle: "Key placement",
			rowAuthParam: "Key param / env name",
			rowToolName: "MCP tool name",
			rowMaxResults: "Max results",
			rowMaxResultsHint: "Empty = follow the global max results.",
			missingId: "ID is required.",
			dupId: "This ID is already used by another row.",
			overridden: "Overridden",
			overridesGlobal: "overrides global",
				keySet: "key set",
				keyRef: "credential ref",
				keyConfigured: "credential configured",
				keyRefMissing: "credential missing",
				keyMissing: "key missing",
				legacyKey: "legacy key",
				legacyKeyBlocked: "This server still uses a hidden legacy literal key. Enter a replacement key or credential reference before changing the server list.",

			customKind: "Custom",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			unsaved: "Unsaved",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
				placeholderUrl: "https://mcp.example.com/mcp/",
				placeholderCommand: "npx",
			placeholderArgs: "-y, duckduckgo-mcp-server",
			placeholderToolName: "tavily_search",
			placeholderAuthParam: "tavilyApiKey"
		};
		const zh = {
			title: "搜索 MCP",
			description: "web_search 工具背后的搜索 MCP 服务器；插件启用期间内置 DeepSeek 搜索保持禁用。",
			defaultServer: "默认服务器",
			defaultServerHint: "使用哪一行服务器（留空 = 第一行）。",
			maxResults: "结果数上限",
			maxResultsHint: "每次搜索最多返回的条数（1–50；留空 = 默认）。",
			searchTimeoutMs: "搜索超时（秒）",
			searchTimeoutMsHint: "超过该时长即中止搜索。",
			servers: "搜索 MCP 服务器",
				serversHint: "选择提供商并填写 CDKey/API key。已知提供商的连接细节由 Host catalog 管理；自定义行才显示 MCP 高级设置。",
				quickAdd: "常用提供商",
				quickAddHint: "添加提供商行后填写 CDKey/API key 再保存。已知提供商不需要填写端点链接。",
			addServer: "添加自定义服务器",
			removeServer: "删除",
			rowId: "ID",
			rowIdHint: "“默认服务器”下拉框引用的稳定标识。",
			rowKind: "提供商",
			rowTransport: "传输方式",
			rowUrl: "端点（URL）",
			rowCommand: "命令",
			rowArgs: "参数（逗号分隔）",
				rowApiKey: "API 密钥",
				cdKey: "CDKey / API key",
				cdKeyHint: "请填写 CDKey / API key",
				keyNotRequired: "无需密钥",

			rowApiKeyEnv: "密钥环境变量/凭证引用",
			rowAuthStyle: "密钥位置",
			rowAuthParam: "密钥参数名/环境变量名",
			rowToolName: "MCP 工具名",
			rowMaxResults: "结果数上限",
			rowMaxResultsHint: "留空 = 跟随全局结果数上限。",
			missingId: "ID 不能为空。",
			dupId: "该 ID 已被另一行占用。",
			overridden: "已覆盖",
			overridesGlobal: "覆盖全局",
				keySet: "已填密钥",
				keyRef: "凭证引用",
				keyConfigured: "凭证已配置",
				keyRefMissing: "凭证未配置",
				keyMissing: "缺少密钥",
				legacyKey: "旧版密钥",
				legacyKeyBlocked: "此服务器仍使用客户端不可见的旧版字面密钥。修改服务器列表前，请输入替代密钥或凭证引用。",

			customKind: "自定义",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改",
			unsaved: "未保存",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
				placeholderUrl: "https://mcp.example.com/mcp/",
				placeholderCommand: "npx",
			placeholderArgs: "-y, duckduckgo-mcp-server",
			placeholderToolName: "tavily_search",
			placeholderAuthParam: "tavilyApiKey"
		};
		//#endregion

		/** Namespace of this plugin's settings section (spelled, not imported). */
		const NS = "search-mcp";

		//#region row helpers
		function emptyRow() {
			return {
				id: "",
				kind: "custom",
				transport: "http",
				url: "",
				command: "",
				args: "",
				apiKey: "",
				apiKeyEnv: "",
				authStyle: "",
				authParam: "",
				toolName: "",
				maxResults: ""
			};
		}
			/** Convert a stored server entry (host shape) to a row draft. */
			function rowFromEntry(entry) {
				const kind = Object.hasOwn(CATALOG, entry.kind) ? entry.kind : "custom";
				const known = kind !== "custom";
				return {
					id: entry.id ?? "",
					kind,
					transport: known ? "" : (entry.transport ?? "http"),
					url: known ? "" : (entry.url ?? ""),
					command: known ? "" : (entry.command ?? ""),
					args: known ? "" : (Array.isArray(entry.args) ? entry.args.join(", ") : ""),
					apiKey: entry.apiKey ?? "",
					apiKeyEnv: entry.apiKeyEnv ?? "",
					authStyle: known ? "" : (entry.authStyle ?? ""),
					authParam: known ? "" : (entry.authParam ?? ""),
					toolName: known ? "" : (entry.toolName ?? ""),
					maxResults: entry.maxResults === undefined ? "" : String(entry.maxResults)
				};
			}
			/** Convert a row draft to the minimal known entry or full custom entry. */
			function entryFromRow(row) {
				const entry = { id: row.id.trim(), kind: row.kind };
				const known = Object.hasOwn(CATALOG, row.kind) && row.kind !== "custom";
				if (!known) {
					entry.transport = row.transport || "http";
					if (entry.transport === "stdio") {
						if (row.command.trim() !== "") entry.command = row.command.trim();
						const args = row.args.split(",").map((a) => a.trim()).filter(Boolean);
						if (args.length > 0) entry.args = args;
					} else if (row.url.trim() !== "") {
						entry.url = row.url.trim();
					}
					if (row.authStyle !== "") entry.authStyle = row.authStyle;
					if (row.authParam.trim() !== "") entry.authParam = row.authParam.trim();
					if (row.toolName.trim() !== "") entry.toolName = row.toolName.trim();
				}
				if (row.apiKey.trim() !== "") entry.apiKey = row.apiKey.trim();
				if (row.apiKeyEnv.trim() !== "") entry.apiKeyEnv = row.apiKeyEnv.trim();
				if (row.maxResults.trim() !== "") {
					const n = Number(row.maxResults);
					if (Number.isFinite(n) && n > 0) entry.maxResults = Math.round(n);
				}
				return entry;
			}
			/** Changing provider starts a clean credential/connection draft. */
			function applyKindDefaults(row, kind) {
				const next = { ...row, kind, apiKey: "", apiKeyEnv: "" };
				if (kind !== "custom") {
					return { ...next, transport: "", url: "", command: "", args: "", authStyle: "", authParam: "", toolName: "" };
				}
				return { ...next, transport: row.transport || "http" };
			}

		/** Suggest a unique row id for a preset kind (tavily, tavily2, …). */
		function suggestId(servers, kind) {
			const used = new Set(servers.map((row) => row.id.trim()).filter(Boolean));
			let id = kind;
			let n = 2;
			while (used.has(id)) id = `${kind}${n++}`;
			return id;
		}
		/** Brand label for a kind, localized for `custom`. */
			function kindLabel(kind, t) {
				if (kind === "custom") return t("customKind");
				return KIND_LABELS[kind] ?? kind;
			}
			function deepEqualJson(left, right) {
				return JSON.stringify(left) === JSON.stringify(right);
			}
			function credentialRefFor(row) {
				if (row.apiKeyEnv.trim() !== "") return row.apiKeyEnv.trim();
				const id = row.id.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
				return `SEARCH_MCP_${id || "SERVER"}_API_KEY`;
			}
			const CREDENTIAL_DESCRIBE_BATCH_SIZE = 64;
			async function describeCredentialRefs(api, refs) {
				const states = {};
				for (let index = 0; index < refs.length; index += CREDENTIAL_DESCRIBE_BATCH_SIZE) {
					const response = await api.credentials.describe({ refs: refs.slice(index, index + CREDENTIAL_DESCRIBE_BATCH_SIZE) });
					if (!response.result.ok) throw new Error("credential state lookup failed");
					Object.assign(states, response.result.value.credentials ?? {});
				}
				return states;
			}
			async function rollbackNewCredentialRefs(api, refs) {
				for (const ref of [...new Set(refs)].reverse()) {
					try {
						await api.credentials.unset({ ref });
					} catch {
						// The save already failed; preserve the original error state.
					}
				}
			}
			async function rollbackSettingsWrites(scope, writes) {
				for (const [field, previous] of writes.reverse()) {
					try {
						if (previous === undefined) await scope.unset(field);
						else await scope.set(field, previous);
					} catch {
						// The UI remains failed so the user can retry or discard the draft.
					}
				}
			}
			//#endregion


		//#region controller (whole-section staged draft)
			var SearchMcpCardController = class {
				constructor(scope, api) {
					this.scope = scope;
					this.api = api;
					this.draft = null;
					this.listeners = new Set();
					this.saving = false;
					this.failed = false;
					this.legacyBlocked = false;
					this.secretStateReady = false;
					this.legacySecretIds = new Set();
					this.credentialStates = {};
					this.store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(this.project());
					scope.subscribe(() => {
						if (this.draft === null) this.publish();
						this.readSecretState();
					});
					this.readSecretState();
				}
				section() {
					return this.scope.getSnapshot();
				}
				value() {
					return this.section().value ?? {};
				}
				userLayer() {
					return this.section().user;
				}
				baseDraft() {
					const value = this.value();
					return {
						defaultServer: typeof value.defaultServer === "string" ? value.defaultServer : "",
						maxResults: typeof value.maxResults === "number" ? String(value.maxResults) : "",
						searchTimeoutMs: typeof value.searchTimeoutMs === "number" ? String(value.searchTimeoutMs) : "",
						servers: Array.isArray(value.servers) ? value.servers.map((entry) => ({
							...rowFromEntry(entry),
							legacySecret: this.legacySecretIds.has(entry.id)
						})) : []
					};
				}
				async readSecretState() {
					let response;
					try {
						response = await this.api.settings.describe({});
					} catch {
						return;
					}
					if (!response.result.ok) return;
					const view = response.result.value.namespaces.find((candidate) => candidate.ns === NS);
					if (view === undefined) return;
					const servers = Array.isArray(view.value?.servers) ? view.value.servers : [];
					const ids = new Set();
					for (const secret of view.secrets ?? []) {
						if (!secret.set || secret.path?.[0] !== "servers" || secret.path?.[2] !== "apiKey") continue;
						const index = Number(secret.path[1]);
						const id = Number.isInteger(index) ? servers[index]?.id : undefined;
						if (typeof id === "string" && id.length > 0) ids.add(id);
					}
					const wasReady = this.secretStateReady;
					const changed = !deepEqualJson([...ids].sort(), [...this.legacySecretIds].sort());
						this.legacySecretIds = ids;
						const previousCredentialStates = this.credentialStates;
						const refs = [...new Set(servers.map((entry) => typeof entry.apiKeyEnv === "string" ? entry.apiKeyEnv.trim() : "").filter(Boolean))];
							if (refs.length > 0) {
								try {
									this.credentialStates = await describeCredentialRefs(this.api, refs);
								} catch {
									this.credentialStates = {};
								}
							} else {
							this.credentialStates = {};
						}

					this.secretStateReady = true;
						const credentialsChanged = !deepEqualJson(previousCredentialStates, this.credentialStates);
						if (this.draft === null && (changed || credentialsChanged || !wasReady)) this.publish();
				}


			ensureDraft() {
				if (this.draft === null) this.draft = this.baseDraft();
				return this.draft;
			}
			project() {
				const snapshot = this.section();
				const draft = this.draft;
				const sectionValue = snapshot.value ?? {};
				const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(this.baseDraft());
				const ids = draft !== null ? draft.servers.map((row) => row.id.trim()) : [];
				const invalid = draft !== null && (ids.some((id) => id === "") || new Set(ids.filter(Boolean)).size !== ids.filter(Boolean).length);
				const serverKinds = draft !== null
					? Object.fromEntries(draft.servers.map((row) => [row.id.trim(), row.kind]))
					: Object.fromEntries((Array.isArray(sectionValue.servers) ? sectionValue.servers : []).map((s) => [s.id, s.kind]));
					return {
						available: snapshot.status === "ready",
						writable: snapshot.writable && this.secretStateReady,

					dirty,
						invalid,
						saving: this.saving,
						failed: this.failed,
						legacyBlocked: this.legacyBlocked,

					overridden: this.userLayer() !== null && typeof this.userLayer() === "object" && !Array.isArray(this.userLayer())
						? Object.keys(this.userLayer()).length > 0
						: false,
					value: draft !== null ? draft : this.baseDraft(),
					serverIds: draft !== null
						? ids.filter(Boolean)
						: (Array.isArray(sectionValue.servers) ? sectionValue.servers.map((s) => s.id).filter(Boolean) : []),
						serverKinds,
						credentialStates: this.credentialStates

				};
			}
			publish() {
				this.store.set(this.project());
			}
			actions() {
				return {
						editScalar: (field, text) => {
							this.ensureDraft()[field] = text;
							this.failed = false;
							this.legacyBlocked = false;
							this.publish();

					},
						editRow: (index, field, value) => {
							const draft = this.ensureDraft();
							draft.servers[index] = { ...draft.servers[index], [field]: value };
							this.failed = false;
							this.legacyBlocked = false;
							this.publish();

					},
						changeKind: (index, kind) => {
							const draft = this.ensureDraft();
							draft.servers[index] = applyKindDefaults(draft.servers[index], kind);
							this.failed = false;
							this.legacyBlocked = false;

						this.publish();
					},
						addServer: () => {
							const draft = this.ensureDraft();
							draft.servers.push(emptyRow());
							this.failed = false;
							this.legacyBlocked = false;

						this.publish();
					},
						quickAdd: (kind) => {
							const draft = this.ensureDraft();
							const id = suggestId(draft.servers, kind);
							const row = applyKindDefaults({ ...emptyRow(), id, kind }, kind);
							draft.servers.push(row);
							this.failed = false;
							this.legacyBlocked = false;

						this.publish();
					},
						removeServer: (index) => {
							const draft = this.ensureDraft();
							draft.servers.splice(index, 1);
							this.failed = false;
							this.legacyBlocked = false;

						this.publish();
					},
						discard: () => {
							if (this.draft === null && !this.failed && !this.legacyBlocked) return;
							this.draft = null;
							this.failed = false;
							this.legacyBlocked = false;
							this.publish();

					},
					save: () => {
						this.save();
					}
				};
			}
					async save() {
						if (this.draft === null || this.saving || !this.secretStateReady) return;

					const draft = this.draft;
					const ids = draft.servers.map((row) => row.id.trim());
					const invalid = ids.some((id) => id === "") || new Set(ids.filter(Boolean)).size !== ids.filter(Boolean).length;
					if (invalid) return;
					const base = this.baseDraft();
					const serversChanged = !deepEqualJson(draft.servers, base.servers);
					if (serversChanged) {
						const blocked = draft.servers.some((row) => row.legacySecret && row.apiKey.trim() === "" && row.apiKeyEnv.trim() === "");
						if (blocked) {
							this.legacyBlocked = true;
							this.publish();
							return;
						}
					}
					this.saving = true;
					this.failed = false;
					this.legacyBlocked = false;
					this.publish();
						let landed = true;
						let serverEntries;
						const createdCredentialRefs = [];
						if (serversChanged) {
							serverEntries = [];
							const credentialWrites = draft.servers
								.filter((row) => row.apiKey.trim() !== "")
								.map((row) => ({ ref: credentialRefFor(row), value: row.apiKey.trim() }));
							let credentialBefore = {};
							try {
								credentialBefore = await describeCredentialRefs(this.api, [...new Set(credentialWrites.map(({ ref }) => ref))]);
							} catch {
								landed = false;
							}
							if (landed && credentialWrites.some(({ ref }) => credentialBefore[ref]?.writable === false)) landed = false;
							if (landed) {
								for (const { ref, value } of credentialWrites) {
									if (!credentialBefore[ref]?.configured) createdCredentialRefs.push(ref);
									try {
										const response = await this.api.credentials.set({ ref, value });
										if (!response.result.ok) {
											landed = false;
											break;
										}
									} catch {
										landed = false;
										break;
									}
								}
							}
							if (!landed) {
								await rollbackNewCredentialRefs(this.api, createdCredentialRefs);
								this.saving = false;
								this.failed = true;
								this.publish();
								return;
							}
							for (const row of draft.servers) {
								const entry = entryFromRow(row);
								if (row.apiKey.trim() !== "") {
									delete entry.apiKey;
									entry.apiKeyEnv = credentialRefFor(row);
								}
								delete entry.legacySecret;
								serverEntries.push(entry);
							}
						}

						const userBefore = this.section().user;
						const rollbackValue = (field) => userBefore !== null && typeof userBefore === "object" && !Array.isArray(userBefore) && Object.hasOwn(userBefore, field)
							? userBefore[field]
							: undefined;
						const writes = [
							["defaultServer", draft.defaultServer.trim(), base.defaultServer, rollbackValue("defaultServer")],
							["maxResults", draft.maxResults.trim() === "" ? undefined : Number(draft.maxResults), base.maxResults === "" ? undefined : Number(base.maxResults), rollbackValue("maxResults")],
							["searchTimeoutMs", draft.searchTimeoutMs.trim() === "" ? undefined : Number(draft.searchTimeoutMs), base.searchTimeoutMs === "" ? undefined : Number(base.searchTimeoutMs), rollbackValue("searchTimeoutMs")],
							...(serversChanged ? [["servers", serverEntries, this.value().servers, rollbackValue("servers")]] : [])
						];
						const completedSettingsWrites = [];
						for (const [field, value, previous, original] of writes) {
							if (deepEqualJson(value, previous)) continue;
							try {
								completedSettingsWrites.push([field, original]);
								if (value === undefined) await this.scope.unset(field);
								else await this.scope.set(field, value);
								const current = this.section().user;
								const ok = value === undefined
									? !(current && Object.hasOwn(current, field))
									: current !== null && typeof current === "object" && !Array.isArray(current) && deepEqualJson(current[field], value);
								if (!ok) {
									landed = false;
									break;
								}
							} catch {
								landed = false;
								break;
							}
						}
						if (!landed) {
							await rollbackSettingsWrites(this.scope, completedSettingsWrites);
							await rollbackNewCredentialRefs(this.api, createdCredentialRefs);
						} else {
							this.draft = null;
						}
						this.saving = false;
						this.failed = !landed;
						this.publish();
						if (landed) this.readSecretState();
				}

			inject() {
				return {
					hooks: { searchMcpCard: this.store },
					...this.actions()
				};
			}
		};
		//#endregion

		//#region components
		function SearchMcpCard(props) {
			const { t } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const state = props.useSearchMcpCard((snapshot) => snapshot);
			if (!state.available) return null;
			const disabled = !state.writable;
			const value = state.value;
			const title = t("title");
			const serverOptions = [
				{ value: "", label: "—" },
				...state.serverIds.map((id) => ({ value: id, label: `${id} · ${kindLabel(state.serverKinds[id], t)}` }))
			];
			const rowIds = value.servers.map((row) => row.id.trim()).filter(Boolean);
			const dupIds = new Set(rowIds.filter((id, index) => rowIds.indexOf(id) !== index));
			return (0, react_jsx_runtime.jsxs)("li", {
				className: "smcp_card" + (open ? " smcp_cardOpen" : ""),
				children: [
					(0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: "smcp_headBtn",
						"aria-expanded": open,
						"aria-label": `${open ? "收起" : "展开"}: ${title}`,
						onClick: () => {
							setOpen(!open);
						},
						children: [
							(0, react_jsx_runtime.jsxs)("span", {
								className: "smcp_head",
								children: [
									(0, react_jsx_runtime.jsx)("span", { className: "smcp_name", children: title }),
									(0, react_jsx_runtime.jsx)("span", { className: "smcp_desc", children: t("description") }),
									state.overridden ? (0, react_jsx_runtime.jsx)("span", { className: "smcp_badge", children: t("overridden") }) : null,
									state.dirty ? (0, react_jsx_runtime.jsx)("span", { className: "smcp_badgeMuted", children: t("unsaved") }) : null
								]
							}),
							(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {
								className: "smcp_chevron" + (open ? " smcp_chevronOpen" : "")
							})
						]
					}),
					open ? (0, react_jsx_runtime.jsxs)("div", {
						className: "smcp_body",
						children: [
							!state.writable ? (0, react_jsx_runtime.jsx)("p", { className: "smcp_hint", children: t("readOnly") }) : null,
							(0, react_jsx_runtime.jsx)(SelectField, {
								id: "smcp-default-server",
								label: t("defaultServer"),
								hint: t("defaultServerHint"),
								disabled,
								options: serverOptions,
								value: value.defaultServer,
								onEdit: (text) => props.editScalar("defaultServer", text)
							}),
							(0, react_jsx_runtime.jsx)(TextField, {
								id: "smcp-max-results",
								label: t("maxResults"),
								hint: t("maxResultsHint"),
								numeric: true,
								disabled,
								value: value.maxResults,
								onEdit: (text) => props.editScalar("maxResults", text)
							}),
							(0, react_jsx_runtime.jsx)(TextField, {
								id: "smcp-timeout",
								label: t("searchTimeoutMs"),
								hint: t("searchTimeoutMsHint"),
								numeric: true,
								disabled,
								value: value.searchTimeoutMs === "" ? "" : String(Math.round(Number(value.searchTimeoutMs) / 1000)),
								onEdit: (text) => props.editScalar("searchTimeoutMs", text === "" ? "" : String(Math.round((Number(text) || 0) * 1000)))
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: "smcp_field",
								children: [
									(0, react_jsx_runtime.jsx)("span", { className: "smcp_label", children: t("servers") }),
									(0, react_jsx_runtime.jsx)("p", { className: "smcp_hint", children: t("serversHint") }),
									(0, react_jsx_runtime.jsx)("p", { className: "smcp_hint", children: t("quickAddHint") }),
									(0, react_jsx_runtime.jsxs)("div", {
										className: "smcp_quickAdd",
										children: QUICK_KINDS.map((kind) => (0, react_jsx_runtime.jsx)(
											"button",
											{
												type: "button",
												className: "smcp_quickBtn",
												disabled,
												onClick: () => props.quickAdd(kind),
												children: `+ ${KIND_LABELS[kind]}`
											},
											`smcp-quick-${kind}`
										))
									}),
									value.servers.map((row, index) => (0, react_jsx_runtime.jsx)(
										ServerRow,
										{
											t,
											row,
											index,
											disabled,
												dupIds,
												credentialStates: state.credentialStates,

											onEdit: (field, val) => props.editRow(index, field, val),
											onKind: (kind) => props.changeKind(index, kind),
											onRemove: () => props.removeServer(index)
										},
										`smcp-row-${index}`
									)),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "smcp_add",
										disabled,
										onClick: props.addServer,
										children: `+ ${t("addServer")}`
									})
								]
							}),
								state.legacyBlocked ? (0, react_jsx_runtime.jsx)("p", { role: "status", className: "smcp_error", children: t("legacyKeyBlocked") }) : null,
								state.failed ? (0, react_jsx_runtime.jsx)("p", { role: "status", className: "smcp_error", children: t("saveFailed") }) : null,

							(0, react_jsx_runtime.jsxs)("div", {
								className: "smcp_footer",
								children: [
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "smcp_btn smcp_btnGhost",
										disabled: !state.dirty || state.saving,
										onClick: props.discard,
										children: t("discard")
									}),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "smcp_btn smcp_btnPrimary",
										disabled: !state.dirty || state.invalid || state.saving,
										onClick: props.save,
										children: t(state.saving ? "saving" : "save")
									})
								]
							})
						]
					}) : null
				]
			});
		}
			function ServerRow(props) {
				const { t, row, index, disabled, onEdit, onKind, onRemove } = props;
				const [rowOpen, setRowOpen] = (0, react.useState)(false);
				const rowInvalid = row.id.trim() === "";
				const dup = !rowInvalid && row.id.trim() !== "" && props.dupIds && props.dupIds.has(row.id.trim());
				const known = row.kind !== "custom";
				const needsKey = (CATALOG[row.kind] ?? CATALOG.custom).needsKey;
				const hasKey = row.apiKey.trim() !== "";
				const hasKeyEnv = row.apiKeyEnv.trim() !== "";
				const hasConfiguredRef = hasKeyEnv && props.credentialStates?.[row.apiKeyEnv.trim()]?.configured === true;
				const hasLegacyKey = row.legacySecret === true;
				const overridesGlobal = row.maxResults.trim() !== "";
				const summary = known ? (needsKey ? (hasKeyEnv ? `${t("keyRef")}: ${row.apiKeyEnv.trim()}` : t("cdKeyHint")) : t("keyNotRequired")) : (row.transport === "stdio"
					? ((row.command.trim() !== "" ? row.command.trim() : "") + (row.args.trim() !== "" ? " " + row.args.trim() : "")).trim() || row.id
					: (row.url.trim() !== "" ? row.url.trim() : row.id));
				const badges = [];
				if (hasKey) badges.push((0, react_jsx_runtime.jsx)("span", { className: "smcp_badge", children: t("keySet") }, "badge-key"));
				else if (hasConfiguredRef) badges.push((0, react_jsx_runtime.jsx)("span", { className: "smcp_badge", children: `${t("keyConfigured")}: ${row.apiKeyEnv.trim()}` }, "badge-env"));
				else if (hasKeyEnv) badges.push((0, react_jsx_runtime.jsx)("span", { className: "smcp_badgeDanger", children: `${t("keyRefMissing")}: ${row.apiKeyEnv.trim()}` }, "badge-env-missing"));
				else if (hasLegacyKey) badges.push((0, react_jsx_runtime.jsx)("span", { className: "smcp_badgeMuted", children: t("legacyKey") }, "badge-legacy-key"));
				else if (needsKey) badges.push((0, react_jsx_runtime.jsx)("span", { className: "smcp_badgeDanger", children: t("keyMissing") }, "badge-key-missing"));
				if (overridesGlobal) badges.push((0, react_jsx_runtime.jsx)("span", { className: "smcp_badgeMuted", children: t("overridesGlobal") }, "badge-override"));
				return (0, react_jsx_runtime.jsxs)("div", {
					className: "smcp_row",
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: "smcp_rowHead",
							children: [
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "smcp_rowToggle" + (rowOpen ? " smcp_rowToggleOpen" : ""),
									"aria-expanded": rowOpen,
									"aria-label": `${rowOpen ? "收起" : "展开"} ${row.id || t("rowId")}`,
									disabled,
									onClick: () => setRowOpen(!rowOpen),
									children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {})
								}),
								(0, react_jsx_runtime.jsx)("span", { className: "smcp_kindBadge", children: kindLabel(row.kind, t) }),
								(0, react_jsx_runtime.jsx)("span", { className: "smcp_rowTitle" + (rowInvalid ? " smcp_invalid" : ""), children: row.id.trim() !== "" ? row.id.trim() : t("rowId") }),
								(0, react_jsx_runtime.jsx)("span", { className: "smcp_rowSummary", children: summary }),
								...badges,
								(0, react_jsx_runtime.jsx)("button", { type: "button", className: "smcp_del", disabled, onClick: onRemove, children: t("removeServer") })
							]
						}),
						rowInvalid ? (0, react_jsx_runtime.jsx)("p", { className: "smcp_error", children: t("missingId") }) : null,
						dup ? (0, react_jsx_runtime.jsx)("p", { className: "smcp_error", children: t("dupId") }) : null,
						rowOpen ? (0, react_jsx_runtime.jsxs)("div", {
							className: "smcp_rowBody",
							children: known ? [
								(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowId"), placeholder: t("rowIdHint"), value: row.id, disabled, onEdit: (v) => onEdit("id", v) }),
								(0, react_jsx_runtime.jsxs)("div", { className: "smcp_rowGrid3", children: [
									(0, react_jsx_runtime.jsx)(CellSelect, { label: t("rowKind"), options: KIND_OPTIONS, value: row.kind, disabled, onEdit: onKind }),
									needsKey ? (0, react_jsx_runtime.jsx)(CellInput, { label: t("cdKey"), type: "password", placeholder: t("cdKeyHint"), value: row.apiKey, disabled, onEdit: (v) => onEdit("apiKey", v) }) : null,
									needsKey ? (0, react_jsx_runtime.jsx)(CellInput, { label: t("rowApiKeyEnv"), placeholder: t("rowApiKeyEnv"), value: row.apiKeyEnv, disabled, onEdit: (v) => onEdit("apiKeyEnv", v) }) : null
								] }),
								(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowMaxResults"), placeholder: t("rowMaxResultsHint"), value: row.maxResults, disabled, onEdit: (v) => onEdit("maxResults", v) })
							] : [
								(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowId"), placeholder: t("rowIdHint"), value: row.id, disabled, onEdit: (v) => onEdit("id", v) }),
								(0, react_jsx_runtime.jsxs)("div", { className: "smcp_rowGrid3", children: [
									(0, react_jsx_runtime.jsx)(CellSelect, { label: t("rowKind"), options: KIND_OPTIONS, value: row.kind, disabled, onEdit: onKind }),
									(0, react_jsx_runtime.jsx)(CellSelect, { label: t("rowTransport"), options: TRANSPORT_OPTIONS, value: row.transport, disabled, onEdit: (v) => onEdit("transport", v) }),
									(0, react_jsx_runtime.jsx)(CellSelect, { label: t("rowAuthStyle"), options: AUTH_STYLE_OPTIONS, value: row.authStyle, disabled, onEdit: (v) => onEdit("authStyle", v) })
								] }),
								(0, react_jsx_runtime.jsxs)("div", { className: "smcp_rowGrid", children: [
									(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowUrl"), placeholder: t("placeholderUrl"), value: row.url, disabled, onEdit: (v) => onEdit("url", v) }),
									(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowApiKey"), type: "password", placeholder: t("cdKeyHint"), value: row.apiKey, disabled, onEdit: (v) => onEdit("apiKey", v) })
								] }),
								(0, react_jsx_runtime.jsxs)("div", { className: "smcp_rowGrid", children: [
									(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowApiKeyEnv"), placeholder: t("rowApiKeyEnv"), value: row.apiKeyEnv, disabled, onEdit: (v) => onEdit("apiKeyEnv", v) }),
									(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowAuthParam"), placeholder: t("placeholderAuthParam"), value: row.authParam, disabled, onEdit: (v) => onEdit("authParam", v) })
								] }),
								(0, react_jsx_runtime.jsxs)("div", { className: "smcp_rowGrid", children: [
									(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowCommand"), placeholder: t("placeholderCommand"), value: row.command, disabled, onEdit: (v) => onEdit("command", v) }),
									(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowArgs"), placeholder: t("placeholderArgs"), value: row.args, disabled, onEdit: (v) => onEdit("args", v) })
								] }),
								(0, react_jsx_runtime.jsxs)("div", { className: "smcp_rowGrid", children: [
									(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowToolName"), placeholder: t("placeholderToolName"), value: row.toolName, disabled, onEdit: (v) => onEdit("toolName", v) }),
									(0, react_jsx_runtime.jsx)(CellInput, { label: t("rowMaxResults"), placeholder: t("rowMaxResultsHint"), value: row.maxResults, disabled, onEdit: (v) => onEdit("maxResults", v) })
								] })
							]
						}) : null
					]
				});
			}

		function CellInput(props) {
			return (0, react_jsx_runtime.jsxs)("label", {
				className: "smcp_cell",
				children: [
					(0, react_jsx_runtime.jsx)("span", { className: "smcp_cellLabel", children: props.label }),
					(0, react_jsx_runtime.jsx)("input", {
						className: "smcp_input",
						type: props.type ?? "text",
						placeholder: props.placeholder,
						value: props.value,
						disabled: props.disabled,
						onChange: (e) => props.onEdit(e.target.value)
					})
				]
			});
		}
		function CellSelect(props) {
			return (0, react_jsx_runtime.jsxs)("label", {
				className: "smcp_cell",
				children: [
					(0, react_jsx_runtime.jsx)("span", { className: "smcp_cellLabel", children: props.label }),
					(0, react_jsx_runtime.jsx)("select", {
						className: "smcp_select",
						value: props.value,
						disabled: props.disabled,
						onChange: (e) => props.onEdit(e.target.value),
						children: props.options.map((option) => (0, react_jsx_runtime.jsx)("option", { value: option, children: option === "" ? "—" : option }, option))
					})
				]
			});
		}
		function TextField(props) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "smcp_field",
				children: [
					(0, react_jsx_runtime.jsx)("label", { className: "smcp_label", htmlFor: props.id, children: props.label }),
					(0, react_jsx_runtime.jsx)("input", {
						id: props.id,
						className: "smcp_input",
						type: "text",
						inputMode: props.numeric ? "numeric" : undefined,
						value: props.value,
						disabled: props.disabled,
						onChange: (e) => props.onEdit(e.target.value)
					}),
					(0, react_jsx_runtime.jsx)("p", { className: "smcp_hint", children: props.hint })
				]
			});
		}
		function SelectField(props) {
			const options = props.options.map((option) => typeof option === "string" ? { value: option, label: option } : option);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "smcp_field",
				children: [
					(0, react_jsx_runtime.jsx)("label", { className: "smcp_label", htmlFor: props.id, children: props.label }),
					(0, react_jsx_runtime.jsx)("select", {
						id: props.id,
						className: "smcp_select",
						value: props.value,
						disabled: props.disabled,
						onChange: (e) => props.onEdit(e.target.value),
						children: options.map((option) => (0, react_jsx_runtime.jsx)("option", { value: option.value, children: option.label }, option.value))
					}),
					(0, react_jsx_runtime.jsx)("p", { className: "smcp_hint", children: props.hint })
				]
			});
		}
		//#endregion

		//#region apply
		/** Required client services (resolved by the client kernel). */
			const inject = ["slots", "locale", "connection", "settingsScope", "remote"];


			function apply(ctx) {
				const { api } = ctx.get("connection");
				const t = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-search-mcp: section dictionaries");
					const controller = new SearchMcpCardController(ctx.settingsScope.bind({ namespace: NS }), api);
					ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
						const used = controller.baseDraft().servers.some((row) => row.apiKeyEnv.trim() === ref);
						if (used) controller.readSecretState();
					}), "dsh-search-mcp: credential status invalidation");

				ctx.slots.inject("settings.plugin.item", function* () {
					yield ctx.slots.register({
						name: "settings.plugin.item",
						key: NS,
						order: 30,

					locale: NS,
					inject: () => controller.inject()
				}, SearchMcpCard);
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
