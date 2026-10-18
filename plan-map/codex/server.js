import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
const store=new Store(process.env.PLAN_MAP_HOME);
const uri='ui://xinshi-plan-map/v8.html';
const base=fileURLToPath(new URL('./web/',import.meta.url));
const html=await readFile(base+'index.html','utf8');const client=await readFile(base+'app.js','utf8');const layout=await readFile(base+'layout.js','utf8');const viewport=await readFile(base+'viewport.js','utf8');
const interaction=await readFile(base+'interaction.js','utf8');
const inline=client.replace(/^import \{[\s\S]*?\} from '\.\/layout\.js';$/m,layout.replaceAll('export ','')).replace(/^import \{[\s\S]*?\} from '\.\/viewport\.js';$/m,viewport.replaceAll('export ','')).replace(/^import \{[\s\S]*?\} from '\.\/interaction\.js';$/m,interaction.replaceAll('export ',''));
if(/^\s*import\s/m.test(inline))throw Error('inline widget still contains an import statement');
const widget=html.replace('<script type="module" src="/app.js"></script>',`<script type="module">${inline}</script>`);
let url;
const token=randomBytes(24).toString('hex');
async function call(name,args){if(name==='plan_list'||name==='plan_dashboard')return {plans:await store.list(),viewerUrl:url+'/'};if(name==='plan_import')return store.import(args);if(name==='plan_node')return store.node(args);if(name==='plan_batch')return store.batch(args);if(name==='plan_history')return store.history(args);if(name==='plan_view')return {...await store.get(args.planId),viewerUrl:url+'/?plan='+encodeURIComponent(args.planId)};throw Error('Unknown tool');}
function md(plan){const arr=Array.isArray(plan.nodes)?plan.nodes:Object.values((plan.state&&plan.state.nodes)||{});const out=[];const seen=new Set();const walk=(id,d)=>{if(seen.has(id))return;seen.add(id);const n=arr.find(x=>x.id===id);if(!n)return;const mark=n.status==='done'?'[x]':n.status==='blocked'?'[!]':n.status==='active'?'[~]':'[ ]';const note=n.note?(' — '+String(n.note).slice(0,160)):'';out.push('  '.repeat(d)+mark+' '+n.title+note);for(const c of arr)if(c.parent===id)walk(c.id,d+1)};for(const n of arr)if(!n.parent)walk(n.id,0);for(const n of arr)walk(n.id,0);const done=arr.filter(n=>n.status==='done').length;return '# '+plan.title+'（rev '+plan.revision+'）\n进度：'+done+'/'+arr.length+'\n\n'+out.join('\n')}
const props={planId:{type:'string'},expectedRevision:{type:'integer',minimum:0},title:{type:'string'},conversation:{type:'string'},outline:{type:'string'},action:{type:'string',enum:['add','update','remove']},id:{type:'string'},parent:{type:'string'},status:{type:'string',enum:['pending','active','done','blocked']},note:{type:'string'}};
props.dependsOn={type:'array',items:{type:'string'},uniqueItems:true};props.blockedReason={type:'string',maxLength:2000};props.afterRevision={type:'integer',minimum:0};props.operations={type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{...props},required:['action','id'],additionalProperties:false}};
const tools=[['plan_batch','Atomically maintain an authorized plan when tasks complete, split, emerge, or dependencies/blockers change. Read current revision first.',['planId','expectedRevision','operations']],['plan_history','Read durable plan mutation history since a revision',['planId']],['plan_dashboard','Open saved plans from the conversation panel; choose the matching plan',[]],['plan_list','List saved plans',[]],['plan_view','Read a plan, current steps and progress; show interactive map',['planId']],['plan_import','Register an approved hierarchical plan. Existing plans require expectedRevision. Do not overwrite without approval.',['planId','outline']],['plan_node','Maintain node status, title or parent as work proceeds. Always read current revision before editing.',['planId','action','id','expectedRevision']]].map(([name,description,required])=>({name,description,inputSchema:{type:'object',properties:['plan_list','plan_dashboard'].includes(name)?{}:props,required,additionalProperties:false},annotations:{readOnlyHint:['plan_list','plan_view','plan_dashboard','plan_history'].includes(name),destructiveHint:['plan_import','plan_node','plan_batch'].includes(name),openWorldHint:false},...(['plan_view','plan_dashboard'].includes(name)?{_meta:{ui:{resourceUri:uri},'openai/outputTemplate':uri,...(name==='plan_dashboard'?{'openai/ui':{entrypoints:[{type:'thread'}]}}:{})}}:{})}));
const web=http.createServer(async(req,res)=>{try{
 const origin='http://'+req.headers.host;if(origin!==url)throw Error('Invalid host');
 const parsed=new URL(req.url,url);res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(parsed.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html.replace('<head>','<head><meta name="plan-token" content="'+token+'">'));return;}
 if(['/app.js','/layout.js','/viewport.js','/interaction.js'].includes(parsed.pathname)){res.setHeader('Content-Type','text/javascript');res.end(parsed.pathname==='/app.js'?client:parsed.pathname==='/layout.js'?layout:parsed.pathname==='/viewport.js'?viewport:interaction);return;}
 if(parsed.pathname==='/api'&&req.method==='POST'){
 if(req.headers.origin!==url||req.headers['x-plan-token']!==token)throw Error('Request rejected');let body='';for await(const chunk of req){body+=chunk;if(body.length>70000)throw Error('Request too large');}const data=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await call(data.name,data.arguments||{})));return;}
 res.writeHead(404);res.end();
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
const fixedPort=Number(process.env.PLAN_MAP_PORT||47821);await new Promise((resolve,reject)=>{web.once('error',(e)=>{if(e.code==='EADDRINUSE')resolve();else reject(e)});web.listen(fixedPort,'127.0.0.1',resolve)});const addr=web.address();url='http://127.0.0.1:'+(addr&&typeof addr==='object'?addr.port:fixedPort);
const server=new Server({name:'xinshi-plan-map',version:'0.6.0'},{capabilities:{tools:{},resources:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{try{const value=await call(params.name,params.arguments||{});let text;if(params.name==='plan_view')text=md(value)+'\n\n浏览器版：'+value.viewerUrl;else if(params.name==='plan_list'||params.name==='plan_dashboard')text='已保存计划：\n'+value.plans.map(p=>'· '+p.title+'（'+p.planId+'，'+p.progress.done+'/'+p.progress.total+'）').join('\n')+'\n\n浏览器版：'+value.viewerUrl;else text=JSON.stringify(value);return {structuredContent:value,content:[{type:'text',text}]};}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});
server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri,name:'Plan Map',mimeType:'text/html;profile=mcp-app'}]}));
server.setRequestHandler(ReadResourceRequestSchema,async({params})=>{if(params.uri!==uri&&!['ui://xinshi-plan-map/v7.html','ui://xinshi-plan-map/v3.html','ui://xinshi-plan-map/v4.html','ui://xinshi-plan-map/v5.html','ui://xinshi-plan-map/v6.html'].includes(params.uri))throw Error('Unknown resource');return {contents:[{uri:params.uri,mimeType:'text/html;profile=mcp-app',text:widget,_meta:{ui:{prefersBorder:true}}}]};});
if(process.argv.includes('--web'))console.log(url);else await server.connect(new StdioServerTransport());
process.stdin.on('end',()=>{if(!process.argv.includes('--web')){web.close();process.exit(0);}});
