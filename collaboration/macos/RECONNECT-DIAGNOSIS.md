# Codex 重连取证与本地桥修复

2026-10-20。状态：已部署HTTP/SSE兼容修复并通过真实多轮与工具验收；正在完成当前桌面会话重载。历史TLS中断的底层责任归因与兼容修复分开记录。

## 已有证据

- 10月19日22:32–23:13，Codex日志跨会话出现云端responses重试与WebSocket错误：33条retry WARN、18条websocket ERROR有重叠；错误文本类别37条TLS handshake EOF、14条TLS close、1条等待超时，不应相加当独立故障次数。
- 主要故障发生在22:25:52唤醒与23:16:31睡眠之间的持续清醒期；不能全部归因睡眠。23:56:50的ERR_NETWORK_CHANGED另与DarkWake对应。
- 客户端26.1013.40934 build20770；当前respect_system_proxy=true。内置CLI显示system_proxy_fallback已默认true，无需再添加同值开关。
- 实际Clash rule模式、TUN开启，系统HTTP/HTTPS/SOCKS指向127.0.0.1:7897。ChatGPT/OpenAI统一命中AI组的美国02，Selector手选；无自动节点切换或错误DIRECT证据。旧配置socket失效，但实际特权服务socket可用；不是代理服务整体失效。
- 当前美国02公共HTTPS节点测试3次674/659/667ms；美国01对照706/670/663ms，均无错；不足以支持更换节点。TUN开启，--noproxy不能等同物理直连。
- 同账号、同模型gpt-6.1-sol、同公共提示的真实CLI：原生默认传输10.60秒返回TRANSPORT_OK；显式自定义SSE provider10.15秒返回相同标记；均exit0、无可见重试。CLI未修改持久config或账号。默认成功不代表已证明其具体transport，也不能据此排除间歇故障。

## 实际修复

协作窗口此前只在加载失败时查找服务，成功加载后不再监测DSH重启产生的新端口；普通宽泛node测试还可能启动真实web桥。现在持续监测本机discovery，同URL不刷新，端口变化自动加载；测试脚本仅运行test/*.test.js，真实桥集成改显式入口。Swift窗口已编译、备份、签名并部署，实际端口加载证据见cli-native-window.log。

面板的网络绿字也改成“HTTPS探测通过；长连接需另行验证”，不再以出口地区探测声称Codex连接稳定。

## 修复前取证判断

历史故障已定位到云端TLS/WebSocket传输路径，登录401、全部休眠解释、当前节点自动乱切、代理服务整体停止均不符合已有证据。但Wi-Fi瞬断、Clash出站节点或远端关闭三者尚不能分离；没有故障当时的同模型同账号路由A/B，不足以给其中一方定责。

保留当前正常且经过真实模型测试的配置。本次未改Clash路由、未切节点、未修改账号或Codex持久provider，不用扩大重试次数掩盖故障。若再次出现，应以故障当时的时间戳抓取同一次请求的客户端错误与Clash链路，再做有判别力的对照；当前不能把未复现写成已修复。

原始安全证据在acceptance/reconnect-log-evidence.json、reconnect-route-evidence.json，以及reconnect-default-probe*、reconnect-sse-probe*。这些本机验收文件被.gitignore排除，未发送给外部模型或GitHub。

官方配置参考：https://developers.openai.com/codex/config-reference/ （supports_websockets属于provider能力字段；内置openai provider在本版本不能同名覆盖，首次不正确临时参数在模型请求前即被拒绝，失败记录保留）。


## 2026-10-20 本轮兼容修复

针对已经反复失败的WebSocket传输路径，正式设置默认provider为openai-http，使用同一官方后端、原有ChatGPT登录与gpt-6.1-sol模型；supports_websockets=false，走HTTP/SSE。没有使用第三方网关、没有切换账号、没有改Clash节点，也没有提高重试次数。

配置工具codex_http_transport.py只改根model_provider及新增同名provider；写入前比较完整TOML结构，保留其余字段。原文件以600权限保存在.codex/backups/http-transport-*，回滚会核对哈希，拒绝覆盖后续编辑。临时fixture已验证应用、幂等、字节一致回滚及后续编辑保护。

实际app-server读取持久配置，确认provider=openai-http、supports_websockets=false、requires_openai_auth=true，模型目录包含gpt-6.1-sol；新线程实际provider同样为openai-http。两轮真实验收：第一轮原生工具等待20秒，计算1至100平方和338350，27.39秒完成；第二轮正确记住CYPRESS-742与计算结果，输出160整数并以HTTP_RESUME_OK结束，6.06秒完成。两个turn均completed，没有error事件。证据：acceptance/reconnect-http-appserver-receipt.json。

当前桌面会话最初持有旧provider=openai，单改配置不足以证明它已经生效。reload_codex_http_transport.py会等待本轮task_complete保存事件，调用官方thread/resume迁移此会话，再自动重启实际客户端，核对新主进程、app-server与SQLite中持久化provider，写入acceptance/reconnect-http-desktop-reload.json。只有该回执status=passed，才代表桌面重载验收完成；不会提前伪报。

这项修改绕开已出故障的WebSocket通道。它不等于证明历史断线必定由Clash或某个节点导致，也不能保证任何网络条件下绝不断线。官方字段依据：[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)与[原有OpenAI认证](https://learn.chatgpt.com/docs/auth)。
