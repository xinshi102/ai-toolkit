/*!
 * dsh-ui-toggles — 插件开关（按钮式 + 热插拔）
 *
 * 基于浏览器端 cordis Loader（ctx.loader / ctx.modules）：
 * - 关闭 = 拆卸 fiber（卸载组件 + 移除该插件样式）
 * - 开启 = 热重载（invalidate → prefetch → refresh → await），即开即用
 * - 每个插件还有独立「⟳ 热重载」按钮
 * - 关闭状态持久化到 localStorage('dsh-plugin-disabled')，刷新后自动恢复
 *
 * 注：本插件自身不出现在列表中（防止把自己关掉后无法找回，只能清 localStorage）。
 */
function apply(ctx) {
  var modLoader = ctx.modules;
  var loader = ctx.loader;
  var KEY = 'dsh-plugin-disabled';

  var CORE = [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-modules',
    '@deepseek-ai/dsh-cordis-client-runner',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-theme'
  ];

  var disabled = new Set();
  try { JSON.parse(localStorage.getItem(KEY) || '[]').forEach(function (id) { disabled.add(id); }); } catch (e) {}

  function persist() { try { localStorage.setItem(KEY, JSON.stringify(Array.from(disabled))); } catch (e) {} }

  function findEntry(id) {
    var it = loader.entries();
    for (var e = it.next(); !e.done; e = it.next()) {
      var en = e.value;
      if (en.options && en.options.name === id) return en;
    }
    return undefined;
  }

  function removeOwnedStyles(id) {
    var list = document.querySelectorAll('style[data-plugin="' + id + '"]');
    for (var i = 0; i < list.length; i++) list[i].remove();
  }

  function teardown(entry) {
    var oldFiber = entry.fiber;
    if (oldFiber !== undefined) {
      var runtime = oldFiber.runtime;
      if (runtime !== null && entry.ctx && entry.ctx.registry) entry.ctx.registry.delete(runtime.callback);
      while (oldFiber.inertia !== undefined) return oldFiber.inertia.then(function () { delete entry.fiber; });
      delete entry.fiber;
    }
    return Promise.resolve();
  }

  function disable(id) {
    var entry = findEntry(id);
    if (!entry) return Promise.resolve();
    return teardown(entry).then(function () {
      removeOwnedStyles(id);
      disabled.add(id); persist();
    });
  }

  function enable(id) {
    var entry = findEntry(id);
    if (!entry) return Promise.resolve();
    modLoader.invalidate(id);
    return modLoader.prefetch(id).then(function () {
      return teardown(entry).then(function () {
        removeOwnedStyles(id);
        return entry.refresh();
      });
    }).then(function () {
      if (entry.fiber) return entry.fiber.await();
    }).then(function () {
      disabled.delete(id); persist();
    });
  }

  function reload(id) {
    var entry = findEntry(id);
    if (!entry) return Promise.resolve();
    modLoader.invalidate(id);
    return modLoader.prefetch(id).then(function () {
      return teardown(entry).then(function () {
        removeOwnedStyles(id);
        return entry.refresh();
      });
    }).then(function () {
      if (entry.fiber) return entry.fiber.await();
    });
  }

  // 恢复持久化的关闭状态（分几轮处理，覆盖启动期晚挂载的插件）
  var pending = Array.from(disabled);
  (function restore() {
    if (pending.length === 0) return;
    var id = pending.shift();
    disable(id).catch(function (err) { ctx.logger && ctx.logger.warn('dsh-ui-toggles: disable failed for ' + id, err); });
    setTimeout(restore, 600);
  })();

  // ── UI：插件坞面板 ──────────────────────────────────────────────────────
  function whenDock(cb) {
    if (window.dshDock) { cb(); return; }
    var t = setInterval(function () { if (window.dshDock) { clearInterval(t); cb(); } }, 200);
    setTimeout(function () { clearInterval(t); }, 15000);
  }
  whenDock(function () {
  window.dshDock.add({
    icon: '🧩',
    label: '插件开关（热插拔）',
    render: function (body) {
      var list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:44vh;overflow:auto;padding-right:2px';
      var rows = [];
      var seen = {};
      var it = loader.entries();
      for (var e = it.next(); !e.done; e = it.next()) {
        var en = e.value;
        var name = en.options && en.options.name;
        if (!name || seen[name]) continue;
        seen[name] = true;
        if (name === '@local/dsh-ui-toggles') continue; // 不显示自己
        rows.push(en);
      }
      rows.sort(function (a, b) { return (a.options.name < b.options.name) ? -1 : 1; });
      rows.forEach(function (en) {
        var name = en.options.name;
        var core = CORE.indexOf(name) >= 0;
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));background:var(--dsw-alias-bg-layer-1,#fff)';
        var label = document.createElement('span');
        label.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-primary,#111)';
        label.textContent = name + (core ? ' ⚠️' : '');
        label.title = name + (core ? '（核心组件，关闭可能导致界面异常）' : '');
        var off = disabled.has(name);
        var sw = document.createElement('button');
        sw.type = 'button';
        sw.style.cssText = 'flex:none;padding:3px 10px;border-radius:999px;border:none;font-size:11px;cursor:pointer;color:#fff;font-weight:600';
        var rl = document.createElement('button');
        rl.type = 'button';
        rl.textContent = '⟳';
        rl.title = '热重载此插件（不改变开关状态）';
        rl.style.cssText = 'flex:none;padding:3px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));font-size:11px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#111)';
        function sync() {
          var isOff = disabled.has(name);
          sw.textContent = isOff ? '关闭' : '开启';
          sw.style.background = isOff ? 'var(--dsw-alias-state-error-primary,#dc1f1f)' : 'var(--dsw-alias-state-success-primary,#22c55e)';
        }
        sw.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!disabled.has(name) && core && !window.confirm('「' + name + '」是核心插件，关闭可能导致界面异常。仍要关闭吗？')) return;
          var p = disabled.has(name) ? enable(name) : disable(name);
          p.then(sync).catch(function (err) { window.alert('操作失败：' + (err && err.message || err)); });
        });
        rl.addEventListener('click', function (ev) {
          ev.stopPropagation();
          rl.textContent = '…';
          reload(name).then(function () { rl.textContent = '⟳'; sync(); })
            .catch(function (err) { rl.textContent = '⟳'; window.alert('重载失败：' + (err && err.message || err)); });
        });
        row.appendChild(label); row.appendChild(rl); row.appendChild(sw);
        list.appendChild(row);
        sync();
      });
      var tip = document.createElement('div');
      tip.style.cssText = 'margin-top:8px;font-size:11px;color:var(--dsw-alias-label-secondary,#666);line-height:1.6';
      tip.textContent = '即开即用：关闭=卸载组件，开启=热重载重新挂载（组件状态会重置）。刷新页面会恢复全部插件；关闭状态保存在 localStorage。';
      body.appendChild(list);
      body.appendChild(tip);
    }
  });
  });
}
