/* dsh-plugin-center — 设置内的统一插件管理页。 */
function apply(ctx) {
  var React = require('react');
  var h = React.createElement;
  var loader = ctx.loader;
  var modules = ctx.modules;
  var KEY = 'dsh-plugin-disabled';
  var disabled = new Set();
  try { JSON.parse(localStorage.getItem(KEY) || '[]').forEach(function (id) { disabled.add(id); }); } catch (e) {}
  function persist() { localStorage.setItem(KEY, JSON.stringify(Array.from(disabled))); }
  function findEntry(id) {
    var it = loader.entries();
    for (var e = it.next(); !e.done; e = it.next()) if (e.value.options && e.value.options.name === id) return e.value;
  }
  function teardown(entry) {
    var fiber = entry && entry.fiber;
    if (!fiber) return Promise.resolve();
    var runtime = fiber.runtime;
    if (runtime !== null && entry.ctx && entry.ctx.registry) entry.ctx.registry.delete(runtime.callback);
    if (fiber.inertia !== undefined) return fiber.inertia.then(function () { delete entry.fiber; });
    delete entry.fiber;
    return Promise.resolve();
  }
  function removeStyles(id) {
    document.querySelectorAll('style[data-plugin="' + id + '"]').forEach(function (node) { node.remove(); });
  }
  function disable(id) {
    var entry = findEntry(id);
    if (!entry) return Promise.reject(new Error('找不到插件：' + id));
    return teardown(entry).then(function () { removeStyles(id); disabled.add(id); persist(); });
  }
  function mount(id, keepDisabled) {
    var entry = findEntry(id);
    if (!entry) return Promise.reject(new Error('找不到插件：' + id));
    modules.invalidate(id);
    return modules.prefetch(id).then(function () {
      return teardown(entry).then(function () { removeStyles(id); return entry.refresh(); });
    }).then(function () { return entry.fiber ? entry.fiber.await() : undefined; }).then(function () {
      if (!keepDisabled) { disabled.delete(id); persist(); }
    });
  }
  function inventory() {
    var rows = [], seen = {}, it = loader.entries();
    for (var e = it.next(); !e.done; e = it.next()) {
      var entry = e.value, name = entry.options && entry.options.name;
      if (!name || seen[name] || name === '@local/dsh-plugin-center') continue;
      seen[name] = true; rows.push(name);
    }
    return rows.sort(function (a, b) {
      var al = a.indexOf('@local/') === 0 ? 0 : 1, bl = b.indexOf('@local/') === 0 ? 0 : 1;
      return al - bl || a.localeCompare(b);
    });
  }
  var btn = { padding: '5px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'inherit', cursor: 'pointer', fontSize: 12 };
  function Switches() {
    var state = React.useState(0), bump = function () { state[1](function (v) { return v + 1; }); };
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('p', { style: { margin: '0 0 4px', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, '用户插件优先显示。开关即时生效；⟳ 会卸载并重新挂载插件。'),
      inventory().map(function (name) {
        var off = disabled.has(name), local = name.indexOf('@local/') === 0;
        return h('div', { key: name, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-3)' } },
          h('span', { title: name, style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: local ? 650 : 400 } }, name),
          h('button', { type: 'button', title: '热重载', style: btn, onClick: function () { mount(name, off).then(bump).catch(function (err) { alert(err.message); }); } }, '⟳'),
          h('button', { type: 'button', style: Object.assign({}, btn, { minWidth: 58, color: '#fff', border: 0, background: off ? '#dc1f1f' : '#22a447' }), onClick: function () {
            (off ? mount(name, false) : disable(name)).then(bump).catch(function (err) { alert(err.message); });
          } }, off ? '已关闭' : '已开启')
        );
      })
    );
  }
  function LegacyPanel(props) {
    var ref = React.useRef(null);
    React.useEffect(function () {
      if (!ref.current) return;
      ref.current.innerHTML = '';
      var result = props.entry.render && props.entry.render(ref.current);
      if (result && result.nodeType) ref.current.appendChild(result);
      return typeof result === 'function' ? result : undefined;
    }, [props.entry]);
    return h('div', { ref: ref });
  }
  function Center() {
    var active = React.useState('switches'), version = React.useState(0);
    React.useEffect(function () {
      var update = function () { version[1](function (v) { return v + 1; }); };
      addEventListener('dsh-plugin-center-change', update);
      return function () { removeEventListener('dsh-plugin-center-change', update); };
    }, []);
    var panels = window.dshPluginCenter ? window.dshPluginCenter.entries().filter(function (entry) {
      // 旧开关面板与本页功能重复，只保留新的统一管理入口。
      return entry.label !== '插件开关（热插拔）';
    }) : [];
    var selected = panels.find(function (entry) { return (entry.id || entry.label) === active[0]; });
    var tabs = [{ id: 'switches', label: '开关与热重载' }].concat(panels.map(function (entry) { return { id: entry.id || entry.label, label: entry.label }; }));
    return h('section', { style: { width: '100%', maxWidth: 820 } },
      h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 } }, tabs.map(function (tab) {
        return h('button', { key: tab.id, type: 'button', style: Object.assign({}, btn, active[0] === tab.id ? { borderColor: 'var(--dsw-alias-state-business-primary)' } : {}), onClick: function () { active[1](tab.id); } }, tab.label);
      })),
      active[0] === 'switches' ? h(Switches) : (selected ? h(LegacyPanel, { entry: selected }) : h(Switches))
    );
  }
  ctx.slots.inject('settings.plugins.tab', function () {
    return ctx.slots.register({ name: 'settings.plugins.tab', id: 'manage', order: -10, label: '管理' }, Center);
  });
}
