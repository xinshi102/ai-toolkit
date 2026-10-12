#!/bin/bash
# apply-dist.sh — 清理旧版直接注入，皮肤由 profile 插件加载。
# 旧版脚本曾重复插入 body/#root，造成整个 Harness 页面可以滚出视口。
set -euo pipefail

D="/Users/xinshi/.hermes/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist"
[ -f "$D/index.html" ] || { echo "找不到 dist: $D"; exit 1; }

python3 - "$D" <<'EOF'
import json, sys
D = sys.argv[1]
p = D + "/index.html"
s = open(p).read()
legacy = ('    <!-- dsh-ui-skins: 皮肤系统 + 插件坞。删除此行可还原官方外观。 -->\n'
          '    <script src="/assets/dsh-ui-skins.js?v=1"></script>\n')
s = s.replace(legacy, '')
if s.count('<body>') != 1 or s.count('id="root"') != 1:
    raise SystemExit('index.html 结构异常：必须只有一个 body 和一个 #root；请恢复官方入口后重试')
open(p, 'w').write(s)
print('index.html verified: one body, one root, no legacy bootstrap')
m = D + "/manifest.webmanifest"
d = json.load(open(m))
d["display"] = "standalone"
json.dump(d, open(m, "w"), ensure_ascii=False, indent=2)
print('manifest:', d["display"])
EOF

echo "✓ 旧版直接注入已清理；皮肤继续由 @local/dsh-ui-skins 插件加载。"
