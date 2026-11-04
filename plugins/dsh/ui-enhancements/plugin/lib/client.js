window.__ModuleLoader__.load({
	id: "@local/dsh-ui-macos",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		exports.name = "@local/dsh-ui-macos";
		exports.inject = [];
		exports.apply = (ctx) => {
			/*!
			 * dsh-macos-skin — macOS desktop-app chrome for the DeepSeek Harness web GUI.
			 *
			 * Adds a native-style unified title bar with traffic-light window controls,
			 * SF Pro system typography and frosted-glass (vibrancy) surfaces. Safe to run
			 * multiple times (idempotent); yields to the durable client plugin when the
			 * plugin's own copy has already applied.
			 *
			 * Disable on next load: localStorage.setItem('dsh-macos-skin', 'off')
			 */
			(function () {
			  'use strict';

			  // ── guards ────────────────────────────────────────────────────────────────
			  if (typeof document === 'undefined') return;
			  try {
			    if (localStorage.getItem('dsh-macos-skin') === 'off') return;
			  } catch (e) { /* storage unavailable — keep going */ }
			  if (document.getElementById('dsh-macos-titlebar')) return; // already applied

			  // ── CSS ───────────────────────────────────────────────────────────────────
			  var CSS = [
			    ':root{--dsh-macos-bar-h:38px}',
			    '#root{padding-top:var(--dsh-macos-bar-h)!important;box-sizing:border-box!important}',
			    'body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif!important}',
			    '#dsh-macos-titlebar{position:fixed;top:0;left:0;right:0;height:var(--dsh-macos-bar-h);z-index:9999;',
			    '  box-sizing:border-box;display:flex;align-items:center;justify-content:center;',
			    '  background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,#f5f6f7) 80%,transparent);',
			    '  -webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);',
			    '  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));',
			    '  -webkit-user-select:none;user-select:none;pointer-events:none}',
			    '#dsh-macos-traffic{position:absolute;left:16px;top:0;bottom:0;display:flex;align-items:center;gap:8px;pointer-events:auto}',
			    '.dsh-macos-light{width:12px;height:12px;border-radius:50%;padding:0;border:1px solid rgba(0,0,0,.14);',
			    '  display:flex;align-items:center;justify-content:center;cursor:default;pointer-events:auto}',
			    '.dsh-macos-light svg{width:8px;height:8px;opacity:0;transition:opacity .12s ease}',
			    '.dsh-macos-light:hover svg{opacity:1}',
			    '#dsh-macos-close{background:#ff5f57}#dsh-macos-close:active{background:#e0443e}',
			    '#dsh-macos-min{background:#febc2e}#dsh-macos-min:active{background:#d99e1a}',
			    '#dsh-macos-zoom{background:#28c840}#dsh-macos-zoom:active{background:#1fa52f}',
			    '#dsh-macos-title{font-size:13px;font-weight:600;letter-spacing:.2px;color:var(--dsw-alias-label-secondary,#555);',
			    '  max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:auto;cursor:default}',
			    '#dsh-macos-title b{font-weight:600}',
			    'html.dsh-macos-standalone #dsh-macos-traffic{display:none}',
			    'html.dsh-macos-standalone #dsh-macos-title{position:absolute;left:84px;top:0;bottom:0;display:flex;align-items:center;max-width:calc(100% - 160px)}'
			  ].join('\n');

			  var style = document.createElement('style');
			  style.id = 'dsh-macos-skin-style';
			  style.setAttribute('data-dsh-macos', '1');
			  style.textContent = CSS;
			  document.head.appendChild(style);

			  // ── title bar DOM ─────────────────────────────────────────────────────────
			  var NS = 'http://www.w3.org/2000/svg';
			  function glyph(pathD, stroke, strokeWidth) {
			    var svg = document.createElementNS(NS, 'svg');
			    svg.setAttribute('viewBox', '0 0 12 12');
			    svg.setAttribute('aria-hidden', 'true');
			    var p = document.createElementNS(NS, 'path');
			    p.setAttribute('d', pathD);
			    p.setAttribute('stroke', stroke);
			    p.setAttribute('stroke-width', String(strokeWidth || 1.3));
			    p.setAttribute('stroke-linecap', 'round');
			    p.setAttribute('fill', 'none');
			    svg.appendChild(p);
			    return svg;
			  }

			  var bar = document.createElement('div');
			  bar.id = 'dsh-macos-titlebar';

			  var traffic = document.createElement('div');
			  traffic.id = 'dsh-macos-traffic';

			  function light(id, title, g) {
			    var b = document.createElement('button');
			    b.type = 'button';
			    b.id = id;
			    b.className = 'dsh-macos-light';
			    b.title = title;
			    b.setAttribute('aria-label', title);
			    b.appendChild(g);
			    return b;
			  }

			  traffic.appendChild(light('dsh-macos-close', '关闭', glyph('M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8', '#4d0000')));
			  traffic.appendChild(light('dsh-macos-min', '最小化（浏览器标签页不支持）', glyph('M2.5 6.5 H9.5', '#995700')));
			  traffic.appendChild(light('dsh-macos-zoom', '全屏 / 还原', glyph('M3 3 H6.5 V4.5 H4.5 V6.5 H3 Z M9 9 H5.5 V7.5 H7.5 V5.5 H9 Z', '#006500', 1.1)));

			  var title = document.createElement('div');
			  title.id = 'dsh-macos-title';
			  title.textContent = 'DeepSeek Harness';

			  bar.appendChild(traffic);
			  bar.appendChild(title);
			  document.body.appendChild(bar);

			  // ── window-control behaviour ──────────────────────────────────────────────
			  document.getElementById('dsh-macos-close').addEventListener('click', function () {
			    try { window.close(); } catch (e) { /* window not script-opened */ }
			  });
			  document.getElementById('dsh-macos-min').addEventListener('click', function () {
			    // Tabs cannot be minimized; macOS-level minimize applies to the whole window.
			  });
			  document.getElementById('dsh-macos-zoom').addEventListener('click', function () {
			    if (document.fullscreenElement) {
			      document.exitFullscreen && document.exitFullscreen().catch(function () {});
			    } else {
			      document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(function () {});
			    }
			  });
			  // Double-click the title text zooms, like a native macOS title bar.
			  title.addEventListener('dblclick', function (ev) {
			    if (ev.target.closest && ev.target.closest('.dsh-macos-light')) return;
			    document.getElementById('dsh-macos-zoom').click();
			  });

			  // ── standalone (installed / --app window) adjustments ─────────────────────
			  function syncStandalone() {
			    var mq = window.matchMedia && window.matchMedia('(display-mode: standalone)');
			    document.documentElement.classList.toggle('dsh-macos-standalone', !!(mq && mq.matches));
			  }
			  syncStandalone();
			  if (window.matchMedia) {
			    try {
			      var mql = window.matchMedia('(display-mode: standalone)');
			      if (mql.addEventListener) mql.addEventListener('change', syncStandalone);
			      else if (mql.addListener) mql.addListener(syncStandalone);
			    } catch (e) { /* older browsers */ }
			  }

			  // Marker for the durable plugin's own guard (harmless here either way).
			  document.documentElement.setAttribute('data-dsh-macos', 'bootstrap');
			})();

		};
		return module.exports;
	}
});
