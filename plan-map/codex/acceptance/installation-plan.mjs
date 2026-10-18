import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const c=new Client({name:'plan-map-installation',version:'1.0'});
const t=new StdioClientTransport({command:process.execPath,args:['E:/AI-Workspace/Projects/Shared/Plan-Map/codex/server.js'],env:{...process.env,PLAN_MAP_HOME:'E:/AI-Workspace/Data/Plan-Map/Codex'}});
try {
 await c.connect(t);
 const id='plan-map-install-20261010';const existing=(await c.callTool({name:'plan_list',arguments:{}})).structuredContent.plans;
 if(!existing.some(p=>p.planId===id))await c.callTool({name:'plan_import',arguments:{planId:id,title:'安装 Plan Map 到 DSH 和 Codex',outline:'# 安装 Plan Map\n- 核对上游和备份\n- 安装 Codex MCP 与技能\n- 配置 DSH desktop 插件\n- 验证协议和浏览器交互\n- 生成验收报告\n- 确认两端会话内界面'}});
 let view=(await c.callTool({name:'plan_view',arguments:{planId:id}})).structuredContent;
 for(const title of ['核对上游和备份','安装 Codex MCP 与技能','配置 DSH desktop 插件','验证协议和浏览器交互','生成验收报告']) {
  const n=view.nodes.find(n=>n.title===title);if(n.status==='done')continue;
  const result=await c.callTool({name:'plan_node',arguments:{planId:id,action:'update',id:n.id,status:'done',expectedRevision:view.revision}});if(result.isError)throw Error(result.content[0].text);view=(await c.callTool({name:'plan_view',arguments:{planId:id}})).structuredContent;
 }
 const root=view.nodes.find(n=>n.id==='p1');if(root.status==='pending'){await c.callTool({name:'plan_node',arguments:{planId:id,action:'update',id:root.id,status:'active',expectedRevision:view.revision}});view=(await c.callTool({name:'plan_view',arguments:{planId:id}})).structuredContent;}
 console.log(JSON.stringify({planId:id,revision:view.revision,progress:view.progress,nodes:view.nodes.map(n=>({id:n.id,title:n.title,status:n.status}))}));
} finally {await c.close();}
