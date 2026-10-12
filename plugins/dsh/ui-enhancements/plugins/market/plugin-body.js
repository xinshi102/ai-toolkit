/*!
 * dsh-ui-market — 插件市场
 *
 * 面向 游戏开发 / 小说写作 / 视频创作 三个领域的插件目录：
 * - 分类浏览 + 搜索；卡片显示 状态徽章（已内置 / 需安装 / 技能包）
 * - 每个卡片提供「复制安装/启用命令」，一键复制到剪贴板
 * - 已安装状态来自 ctx.remote.pluginInventory（不可用时退化为内置清单）
 *
 * 说明：DSH 的"安装"= npm 安装 + profile 配置行（cordis.patch.yml），
 * 见卡片内复制出的命令；技能包 = 放入 ~/.dsh/skills/ 的 SKILL.md。
 */
function apply(ctx) {
  var CATALOG = [
    // ── 游戏开发 ──────────────────────────────────────────────────────
    { cat: '游戏开发', title: 'MCP 客户端（引擎/工具接入）', pkg: '@deepseek-ai/dsh-mcp-client', kind: 'builtin',
      desc: '连接 MCP 服务器：Unity/Unreal 控制台、Blender、素材库、关卡数据等。让 AI 直接读写你的工程工具。',
      cmd: '在 profile 配置里启用 mcp-client 并填写服务器地址（见 README）' },
    { cat: '游戏开发', title: '持久化终端', pkg: '@deepseek-ai/dsh-tool-bash-persistent', kind: 'builtin',
      desc: '长驻 Shell 会话：保持引擎/构建进程存活，跨轮次复用工作目录与环境变量，适合热重载循环。',
      cmd: '默认已内置；如需独立启用，在 cordis.patch.yml 插入 tool-bash-persistent 行' },
    { cat: '游戏开发', title: '定时任务调度', pkg: '@deepseek-ai/dsh-schedule', kind: 'builtin',
      desc: '定时/周期任务：每日构建检查、素材同步、自动化测试提醒。',
      cmd: '默认已内置，可用 /schedule 或配置文件创建任务' },
    { cat: '游戏开发', title: '工作流编排', pkg: '@deepseek-ai/dsh-workflow', kind: 'builtin',
      desc: '多子代理并行执行：批量资源校验、全项目重构、多关卡检查可一键分发。',
      cmd: '默认已内置（workflow 工具），直接让 AI 使用 workflow 工具即可' },
    { cat: '游戏开发', title: '技能包：游戏开发', pkg: 'skill:game-dev', kind: 'skill',
      desc: '项目结构规范、引擎命令速查、构建/性能检查清单、代码评审标准。',
      cmd: '已安装到 ~/.dsh/skills/game-dev/，市场技能分类可查看' },

    // ── 小说写作 ──────────────────────────────────────────────────────
    { cat: '小说写作', title: '会话压缩', pkg: '@deepseek-ai/dsh-command-compact', kind: 'builtin',
      desc: '长篇小说连载时压缩历史：保留世界观/人物/伏笔摘要，防止上下文溢出。',
      cmd: '默认已内置，使用 /compact 命令' },
    { cat: '小说写作', title: '智能会话标题', pkg: '@deepseek-ai/dsh-session-title-llm', kind: 'builtin',
      desc: '用 LLM 为每个会话生成书名/章节式标题，多卷作品管理更清晰。',
      cmd: '默认已内置（session-title）' },
    { cat: '小说写作', title: '输出保留策略', pkg: '@deepseek-ai/dsh-output-retention', kind: 'builtin',
      desc: '控制长输出的保留方式，适合大段正文生成不被截断。',
      cmd: '默认已内置' },
    { cat: '小说写作', title: '网络调研', pkg: '@deepseek-ai/dsh-tool-web', kind: 'builtin',
      desc: '写作考据：历史、地理、风俗、专业设定实时查证，避免硬伤。',
      cmd: '默认已内置（web_search 工具）' },
    { cat: '小说写作', title: '技能包：小说写作', pkg: 'skill:novel-writing', kind: 'skill',
      desc: '写作规范、世界观/人物卡模板、章节大纲法、伏笔追踪表、文风控制。',
      cmd: '已安装到 ~/.dsh/skills/novel-writing/' },

    // ── 视频创作 ──────────────────────────────────────────────────────
    { cat: '视频创作', title: '附件/素材管理', pkg: '@deepseek-ai/dsh-attachment', kind: 'builtin',
      desc: '在对话中挂截图、分镜、脚本、素材文件，AI 可读取内容。',
      cmd: '默认已内置（attachment）' },
    { cat: '视频创作', title: '定时任务调度', pkg: '@deepseek-ai/dsh-schedule', kind: 'builtin',
      desc: '脚本交稿提醒、发布排期、素材备份计划。',
      cmd: '默认已内置' },
    { cat: '视频创作', title: 'MCP 客户端（剪辑软件接入）', pkg: '@deepseek-ai/dsh-mcp-client', kind: 'builtin',
      desc: '通过社区 MCP 桥接 Premiere/剪映/Final Cut 的工程数据（若你有对应 MCP 服务器）。',
      cmd: '在 profile 配置启用 mcp-client' },
    { cat: '视频创作', title: '技能包：视频创作', pkg: 'skill:video-creation', kind: 'skill',
      desc: '分镜脚本模板、口播文案风格、标题/封面文案生成、发布平台规范。',
      cmd: '已安装到 ~/.dsh/skills/video-creation/' },

    // ── 效率 / 系统 ───────────────────────────────────────────────────
    { cat: '效率工具', title: '背景任务', pkg: '@deepseek-ai/dsh-tool-jobs', kind: 'builtin',
      desc: '长任务后台运行，完成后通知；不阻塞当前对话。',
      cmd: '默认已内置（job_* 工具）' },
    { cat: '效率工具', title: '子代理协作', pkg: '@deepseek-ai/dsh-tool-subagent', kind: 'builtin',
      desc: '把调研/写作/编码任务拆给子代理并行处理，大幅提速。',
      cmd: '默认已内置（subagent 工具）' },
    { cat: '效率工具', title: '目标管理', pkg: '@deepseek-ai/dsh-goal', kind: 'builtin',
      desc: '长周期目标跨轮次推进，自动续跑，适合大型创作/开发项目。',
      cmd: '默认已内置（goal 工具）' },
    { cat: '效率工具', title: '视觉识别（DeepSeek API）', pkg: 'external:vision', kind: 'info',
      desc: '官方 deepseek-v4-flash-vision-exp 模型支持图片输入：截图审阅、分镜画面分析。',
      cmd: '代码示例见工作区文档 deepseek-视觉识别-教学文档.md' }
  ];

  var installed = new Set();
  var inventoryReady = false;
  if (ctx.remote && ctx.remote.pluginInventory) {
    try {
      ctx.remote.pluginInventory.list().then(function (r) {
        if (r && r.ok && Array.isArray(r.value)) {
          r.value.forEach(function (v) { installed.add(v.moduleName); });
          inventoryReady = true;
        }
      }).catch(function () {});
    } catch (e) {}
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function copyText(t) {
    try {
      navigator.clipboard.writeText(t).then(function () {
        window.alert('已复制：\n' + t);
      }, function () { window.alert('复制失败，请手动复制：\n' + t); });
    } catch (e) { window.alert('复制失败，请手动复制：\n' + t); }
  }

  var CATS = ['全部', '游戏开发', '小说写作', '视频创作', '效率工具'];
  var activeCat = '全部';

  function badgeFor(item) {
    if (item.kind === 'skill') return ['技能包', 'var(--dsw-alias-state-business-primary,#4176e6)'];
    if (item.kind === 'info') return ['信息', 'var(--dsw-static-neutral-bluish-400,#adb2b8)'];
    if (item.kind === 'builtin') return ['已内置', 'var(--dsw-alias-state-success-primary,#22c55e)'];
    return ['需安装', 'var(--dsw-alias-state-warn-primary,#f59e0b)'];
  }

  function buildList(body) {
    body.innerHTML = '';
    var search = document.createElement('input');
    search.type = 'text';
    search.placeholder = '搜索插件…';
    search.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);font-size:12px;margin-bottom:8px';
    body.appendChild(search);

    var tabs = document.createElement('div');
    tabs.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px';
    CATS.forEach(function (c) {
      var t = document.createElement('button');
      t.type = 'button'; t.textContent = c;
      t.style.cssText = 'padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);cursor:pointer;font-size:11px';
      t.addEventListener('click', function () { activeCat = c; render(); });
      tabs.appendChild(t);
    });
    body.appendChild(tabs);

    var list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow:auto;padding-right:2px';
    body.appendChild(list);

    function render() {
      var kw = (search.value || '').trim().toLowerCase();
      list.innerHTML = '';
      CATALOG.forEach(function (item) {
        if (activeCat !== '全部' && item.cat !== activeCat) return;
        if (kw && (item.title + item.desc + item.pkg).toLowerCase().indexOf(kw) < 0) return;
        var card = document.createElement('div');
        card.style.cssText = 'padding:9px 10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));background:var(--dsw-alias-bg-layer-1,#fff)';
        var head = document.createElement('div');
        head.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';
        var title = document.createElement('span');
        title.style.cssText = 'flex:1;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#111)';
        title.textContent = item.title;
        var badge = badgeFor(item);
        var b = document.createElement('span');
        b.textContent = badge[0];
        b.style.cssText = 'flex:none;font-size:10px;padding:2px 8px;border-radius:999px;color:#fff;background:' + badge[1];
        head.appendChild(title); head.appendChild(b);
        var desc = document.createElement('div');
        desc.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary,#666);line-height:1.55;margin-bottom:6px';
        desc.textContent = item.desc;
        var pkgLine = document.createElement('div');
        pkgLine.style.cssText = 'font-size:10px;color:var(--dsw-alias-label-tertiary,#888);font-family:ui-monospace,Menlo,monospace;margin-bottom:6px;word-break:break-all';
        pkgLine.textContent = item.pkg;
        var act = document.createElement('button');
        act.type = 'button';
        act.textContent = item.kind === 'skill' ? '查看技能' : (item.kind === 'info' ? '查看文档' : '复制命令');
        act.style.cssText = 'padding:4px 10px;border-radius:8px;border:none;background:var(--dsw-alias-state-business-primary,#4176e6);color:#fff;cursor:pointer;font-size:11px';
        act.addEventListener('click', function () { copyText(item.cmd); });
        card.appendChild(head); card.appendChild(desc); card.appendChild(pkgLine); card.appendChild(act);
        list.appendChild(card);
      });
      if (list.childNodes.length === 0) {
        var empty = document.createElement('div');
        empty.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary,#666);padding:12px 0;text-align:center';
        empty.textContent = '没有匹配的插件';
        list.appendChild(empty);
      }
    }
    search.addEventListener('input', render);
    render();
  }

  function whenDock(cb) {
    if (window.dshDock) { cb(); return; }
    var t = setInterval(function () { if (window.dshDock) { clearInterval(t); cb(); } }, 200);
    setTimeout(function () { clearInterval(t); }, 15000);
  }
  whenDock(function () {
  window.dshDock.add({
    icon: '🛍️',
    label: '插件市场',
    render: buildList
  });
  });
}
