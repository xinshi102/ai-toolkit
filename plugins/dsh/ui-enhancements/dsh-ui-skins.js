/*!
 * dsh-ui-skins — DeepSeek Harness Web GUI 皮肤系统
 *
 * 内置皮肤：macOS 桌面 / 默认 / 暗夜玻璃 / 极简 / 自定义(CSS)
 * - 切换即时生效（无需刷新），选择持久化到 localStorage
 * - 浮动「插件坞」按钮（右下角），与插件开关、插件市场共用
 * - 暴露 window.dshSkins（切换/注册 API）与 window.dshDock（坞注册）
 *
 * 关闭：localStorage.setItem('dsh-skins','off') 后刷新
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  try { if (localStorage.getItem('dsh-skins') === 'off') return; } catch (e) { /* keep going */ }
  if (window.dshSkins) return; // 已加载（插件版或引导版）

  var SKIN_KEY = 'dsh-skin';
  var CUSTOM_KEY = 'dsh-skin-custom';

  // ── helpers ───────────────────────────────────────────────────────────────
  function addStyle(id, css) {
    var tag = document.getElementById(id);
    if (!tag) { tag = document.createElement('style'); tag.id = id; document.head.appendChild(tag); }
    tag.textContent = css || '';
    return tag;
  }
  function removeStyle(id) { var t = document.getElementById(id); if (t) t.remove(); }
  function el(tag, attrs, parent) {
    var n = document.createElement(tag);
    for (var k in attrs) if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // ── 皮肤定义 ──────────────────────────────────────────────────────────────
  var skins = {};
  function registerSkin(s) { skins[s.id] = s; }

  // —— macOS 桌面：毛玻璃标题栏 + 红绿灯 ——
  var MACOS_CSS = [
    ':root{--dsh-macos-bar-h:38px}',
    'html,body{width:100%;height:100%;overflow:hidden!important;overscroll-behavior:none}',
    '#root{padding-top:var(--dsh-macos-bar-h)!important;box-sizing:border-box!important}',
    '#root{position:fixed!important;inset:0!important;height:auto!important;overflow:hidden!important;overscroll-behavior:none}',
    '#root [class*="_sidebarCol"],#root [class*="_regionArea"]{overscroll-behavior-y:contain}',
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
    'html.dsh-macos-standalone #dsh-macos-traffic{display:none}',
    'html.dsh-macos-standalone #dsh-macos-title{position:absolute;left:84px;top:0;bottom:0;display:flex;align-items:center;max-width:calc(100% - 160px)}'
  ].join('\n');

  function mountMacos() {
    var NS = 'http://www.w3.org/2000/svg';
    function glyph(d, stroke, w) {
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 12 12');
      svg.setAttribute('aria-hidden', 'true');
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d); p.setAttribute('stroke', stroke);
      p.setAttribute('stroke-width', String(w || 1.3));
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('fill', 'none');
      svg.appendChild(p); return svg;
    }
    var bar = el('div', { id: 'dsh-macos-titlebar' });
    var traffic = el('div', { id: 'dsh-macos-traffic' }, bar);
    function light(id, title, g) {
      var b = el('button', { type: 'button', id: id, 'class': 'dsh-macos-light', title: title, 'aria-label': title }, traffic);
      b.appendChild(g); return b;
    }
    light('dsh-macos-close', '关闭', glyph('M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8', '#4d0000'));
    light('dsh-macos-min', '最小化（浏览器标签页不支持）', glyph('M2.5 6.5 H9.5', '#995700'));
    light('dsh-macos-zoom', '全屏 / 还原', glyph('M3 3 H6.5 V4.5 H4.5 V6.5 H3 Z M9 9 H5.5 V7.5 H7.5 V5.5 H9 Z', '#006500', 1.1));
    var title = el('div', { id: 'dsh-macos-title', text: 'DeepSeek Harness' }, bar);
    document.body.appendChild(bar);

    var onClose = function () { try { window.close(); } catch (e) {} };
    var onZoom = function () {
      if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen().catch(function () {}); }
      else { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(function () {}); }
    };
    var onTitleDbl = function (ev) {
      if (ev.target.closest && ev.target.closest('.dsh-macos-light')) return;
      onZoom();
    };
    document.getElementById('dsh-macos-close').addEventListener('click', onClose);
    document.getElementById('dsh-macos-zoom').addEventListener('click', onZoom);
    title.addEventListener('dblclick', onTitleDbl);

    var mql = null;
    function sync() { document.documentElement.classList.toggle('dsh-macos-standalone', !!(mql && mql.matches)); }
    if (window.matchMedia) {
      try {
        mql = window.matchMedia('(display-mode: standalone)');
        if (mql.addEventListener) mql.addEventListener('change', sync); else if (mql.addListener) mql.addListener(sync);
      } catch (e) {}
    }
    sync();

    // The Harness columns are fixed-layout panels. Keep the browser document itself
    // at the origin, and consume a sidebar wheel only when its own scroll region has
    // reached an edge. This prevents WebKit/Blink scroll chaining from moving #root.
    function lockDocumentScroll() {
      var scrolling = document.scrollingElement;
      if (scrolling && (scrolling.scrollTop || scrolling.scrollLeft)) {
        scrolling.scrollTop = 0;
        scrolling.scrollLeft = 0;
      }
    }
    function onSidebarWheel(event) {
      var target = event.target && event.target.closest ? event.target : null;
      var sidebar = target && target.closest('[class*="_sidebarCol"]');
      if (!sidebar) return;
      var node = target;
      while (node && node !== sidebar) {
        var style = window.getComputedStyle(node);
        var scrollable = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
        if (scrollable) {
          var canMove = event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1;
          if (canMove) return;
          break;
        }
        node = node.parentElement;
      }
      event.preventDefault();
      event.stopPropagation();
      lockDocumentScroll();
    }
    window.addEventListener('scroll', lockDocumentScroll, { passive: true });
    document.addEventListener('wheel', onSidebarWheel, { capture: true, passive: false });
    lockDocumentScroll();

    return function () {
      document.getElementById('dsh-macos-close') && document.getElementById('dsh-macos-close').removeEventListener('click', onClose);
      document.getElementById('dsh-macos-zoom') && document.getElementById('dsh-macos-zoom').removeEventListener('click', onZoom);
      title.removeEventListener('dblclick', onTitleDbl);
      if (mql) { if (mql.removeEventListener) mql.removeEventListener('change', sync); else if (mql.removeListener) mql.removeListener(sync); }
      window.removeEventListener('scroll', lockDocumentScroll);
      document.removeEventListener('wheel', onSidebarWheel, true);
      bar.remove();
      document.documentElement.classList.remove('dsh-macos-standalone');
    };
  }

  registerSkin({ id: 'macos', label: 'macOS 桌面', desc: '毛玻璃标题栏 + 红绿灯窗口按钮', css: MACOS_CSS, mount: mountMacos });

  registerSkin({ id: 'default', label: '默认', desc: '官方默认外观', css: '', mount: function () { return function () {}; } });

  // —— 暗夜玻璃：毛玻璃卡片 + 霓虹强调（自适应明暗主题） ——
  registerSkin({
    id: 'dark-glass', label: '暗夜玻璃', desc: '毛玻璃卡片 + 渐变霓虹，深色下效果最佳',
    css: [
      ':root{--dsh-glass-grad:linear-gradient(135deg,rgba(88,126,255,.35),rgba(255,86,190,.28))}',
      'body{background:var(--dsw-alias-bg-base)}',
      '#root>div>div{background:transparent!important}',
      'body:not([data-ds-dark-theme]) #root{background:radial-gradient(1200px 600px at 80% -10%,rgba(88,126,255,.10),transparent 60%),radial-gradient(900px 500px at 10% 110%,rgba(255,86,190,.08),transparent 60%)}',
      'body[data-ds-dark-theme] #root{background:radial-gradient(1200px 600px at 80% -10%,rgba(88,126,255,.14),transparent 60%),radial-gradient(900px 500px at 10% 110%,rgba(255,86,190,.10),transparent 60%)}',
      '[class$="_card"],.uV2eYG_card{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base)) 72%,transparent)!important;',
      '  -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);',
      '  border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2,rgba(0,0,0,.1)) 80%,transparent)!important;',
      '  box-shadow:0 8px 32px rgba(0,0,0,.12)!important}',
      '[class$="_primary"],.uV2eYG_primary{background:var(--dsh-glass-grad),var(--dsw-alias-brand-primary)!important;border:none!important;',
      '  box-shadow:0 4px 20px rgba(88,126,255,.35)!important}',
      '[class$="_composerSeat"]{background:transparent!important}',
      '[class$="_heroGlow"]{opacity:.8}',
      '[class$="_sidebarCol"]{background:color-mix(in srgb,var(--dsw-specific-sidebar-fill,#f5f6f7) 60%,transparent)!important;',
      '  -webkit-backdrop-filter:blur(18px) saturate(150%);backdrop-filter:blur(18px) saturate(150%)}',
      'body[data-ds-dark-theme] ::selection{background:rgba(88,126,255,.4)}'
    ].join('\n'),
    mount: function () { return function () {}; }
  });

  // —— 极简：去装饰、内容优先 ——
  registerSkin({
    id: 'minimal', label: '极简', desc: '弱化背景装饰与阴影，内容优先',
    css: [
      '[class$="_heroGlow"],.wSkVaW_heroGlow{opacity:.25!important}',
      '[class$="_card"],.uV2eYG_card{box-shadow:none!important;border-radius:10px!important}',
      '[class$="_sidebarCol"]{background:var(--dsw-alias-bg-layer-1)!important}',
      '[class$="_composerSeat"]{background:transparent!important}',
      '[class*="_workspace"]{box-shadow:none!important}',
      'body{background:var(--dsw-alias-bg-base)}'
    ].join('\n'),
    mount: function () { return function () {}; }
  });

  // —— 自定义 CSS ——
  function customCss() { try { return localStorage.getItem(CUSTOM_KEY) || ''; } catch (e) { return ''; } }
  registerSkin({ id: 'custom', label: '自定义', desc: '粘贴你自己的 CSS（localStorage 持久化）', css: '', mount: function () { return function () {}; } });

  // ── 应用皮肤 ──────────────────────────────────────────────────────────────
  var current = null;
  var cleanup = null;
  var styleTagId = 'dsh-skin-style';

  function applySkin(id) {
    // 桌面端已有 macOS 原生标题栏，不再叠加网页仿制标题栏。
    if (id === 'macos' || !skins[id]) id = 'default';
    if (id === 'custom') { addStyle(styleTagId, customCss()); }
    else { addStyle(styleTagId, skins[id].css); }
    if (cleanup) { try { cleanup(); } catch (e) {} cleanup = null; }
    current = id;
    cleanup = skins[id].mount ? skins[id].mount() : function () {};
    try { localStorage.setItem(SKIN_KEY, id); } catch (e) {}
    document.documentElement.setAttribute('data-dsh-skin', id);
    if (window.dshSkinsUI) window.dshSkinsUI.sync(id);
  }

  function getCurrent() {
    try {
      var saved = localStorage.getItem(SKIN_KEY) || 'default';
      return saved === 'macos' ? 'default' : saved;
    } catch (e) { return 'default'; }
  }

  // ── 插件坞（与插件开关、插件市场共用） ──────────────────────────────────
  var DOCK_CSS = [
    '#dsh-dock{position:fixed;right:14px;bottom:14px;z-index:9980;display:flex;align-items:flex-end}',
    '.dsh-dock-btn{width:40px;height:40px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));',
    '  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 85%,transparent);color:var(--dsw-alias-label-primary,#111);',
    '  font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
    '  box-shadow:0 4px 16px rgba(0,0,0,.14);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);',
    '  transition:transform .12s ease}',
    '.dsh-dock-btn:hover{transform:translateY(-2px)}',
    '.dsh-dock-pop{position:fixed;right:14px;bottom:62px;z-index:9981;width:380px;max-width:calc(100vw - 28px);max-height:72vh;overflow:auto;',
    '  background:color-mix(in srgb,var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base)) 92%,transparent);',
    '  -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);',
    '  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,.22);',
    '  color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:1.5;display:none}',
    '.dsh-dock-pop.open{display:block}',
    '.dsh-dock-pop h3{margin:0;padding:12px 14px 8px;font-size:13px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
    '.dsh-dock-pop .body{padding:10px 14px 14px}',
    '.dsh-plugin-home{display:flex;flex-direction:column;gap:7px}',
    '.dsh-plugin-home button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);cursor:pointer;text-align:left}',
    '.dsh-plugin-home button:hover{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.16))}',
    '.dsh-plugin-back{border:0;background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:0 0 8px;opacity:.72}'
  ].join('\n');
  addStyle('dsh-dock-style', DOCK_CSS);

  function ensureDock() {
    var dock = document.getElementById('dsh-dock');
    if (!dock) { dock = el('div', { id: 'dsh-dock' }); document.body.appendChild(dock); }
    return dock;
  }

  var pop = null;
  function ensurePop() {
    if (!pop) { pop = el('div', { id: 'dsh-dock-pop', 'class': 'dsh-dock-pop' }); document.body.appendChild(pop); }
    return pop;
  }
  function closePop() { if (pop) pop.classList.remove('open'); }

  // 兼容旧插件的无界面注册表。各插件仍调用 dshDock.add，
  // 但入口由「设置 → 插件 → 管理」统一渲染，不再创建右下角按钮。
  var panelEntries = [];
  function notifyPanels() {
    window.dispatchEvent(new CustomEvent('dsh-plugin-center-change'));
  }
  window.dshPluginCenter = {
    entries: function () { return panelEntries.slice(); },
    add: function (entry) {
      var key = entry.id || entry.label;
      var index = panelEntries.findIndex(function (item) { return (item.id || item.label) === key; });
      if (index >= 0) panelEntries[index] = entry; else panelEntries.push(entry);
      notifyPanels();
      return {
        open: function () {},
        close: function () {},
        btn: null,
        remove: function () {
          panelEntries = panelEntries.filter(function (item) { return (item.id || item.label) !== key; });
          notifyPanels();
        }
      };
    }
  };
  window.dshDock = window.dshPluginCenter;

  // ── 皮肤选择器 UI ────────────────────────────────────────────────────────
  var pickerEntry = null;
  var pickerState = { selected: null };

  function buildPicker() {
    var root = document.createElement('div');
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.gap = '8px';
    var order = ['default', 'dark-glass', 'minimal', 'custom'];
    var btns = {};
    order.forEach(function (id) {
      var s = skins[id];
      var b = el('button', {
        type: 'button', text: (s.label + ' — ' + s.desc),
        style: 'text-align:left;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);cursor:pointer;font-size:12px;line-height:1.45'
      }, root);
      b.dataset.skin = id;
      b.addEventListener('click', function () { applySkin(id); sync(); });
      btns[id] = b;
    });
    // 自定义 CSS 输入
    var ta = el('textarea', {
      placeholder: '在此粘贴自定义 CSS（作用于全局，刷新后仍生效）',
      style: 'width:100%;box-sizing:border-box;height:120px;resize:vertical;margin-top:2px;padding:8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px'
    }, root);
    ta.value = customCss();
    var saveBtn = el('button', { type: 'button', text: '应用自定义 CSS', style: 'padding:6px 10px;border-radius:10px;border:none;background:var(--dsw-alias-brand-primary,#111);color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer;font-size:12px' }, root);
    saveBtn.addEventListener('click', function () {
      try { localStorage.setItem(CUSTOM_KEY, ta.value); } catch (e) {}
      if (getCurrent() === 'custom') applySkin('custom'); else applySkin('custom');
      sync();
    });
    function sync() {
      var cur = getCurrent();
      order.forEach(function (id) {
        btns[id].style.outline = (id === cur) ? '2px solid var(--dsw-alias-state-business-primary,#4176e6)' : 'none';
      });
      pickerState.selected = cur;
    }
    sync();
    return root;
  }

  function initPicker() {
    if (pickerEntry) return;
    pickerEntry = window.dshDock.add({ icon: '🎨', label: '切换皮肤', render: buildPicker });
  }

  // ── 对外 API ──────────────────────────────────────────────────────────────
  window.dshSkins = {
    skins: skins,
    get current() { return getCurrent(); },
    set: applySkin,
    apply: applySkin,
    register: registerSkin,
    initPicker: initPicker
  };
  window.dshSkinsUI = { sync: function () {} };

  // ── 启动：应用已选皮肤 + 初始化选择器 ────────────────────────────────────
  applySkin(getCurrent());
  initPicker();
})();
