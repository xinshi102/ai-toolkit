import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
const store=new Store(process.env.PLAN_MAP_HOME);
const uri='ui://xinshi-plan-map/v5.html';
const base=fileURLToPath(new URL('./web/',import.meta.url));
const html=await readFile(base+'index.html','utf8');const client=await readFile(base+'app.js','utf8');const layout=await readFile(base+'layout.js','utf8');const viewport=await readFile(base+'viewport.js','utf8');
const widget=html.replace('<script type="module" src="/app.js"></script>',`<script type="module">${client.replace("import { layoutTree, truncateToWidth } from './layout.js';",layout.replaceAll('export ','')).replace("import { graphViewport } from './viewport.js';",viewport.replaceAll('export ',''))}</script>`);
let url;
const token=randomBytes(24).toString('hex');
async function call(name,args){if(name==='plan_list'||name==='plan_dashboard')return {plans:await store.list(),viewerUrl:url+'/'};if(name==='plan_import')return store.import(args);if(name==='plan_node')return store.node(args);if(name==='plan_view')return {...await store.get(args.planId),viewerUrl:url+'/?plan='+encodeURIComponent(args.planId)};throw Error('Unknown tool');}
const props={planId:{type:'string'},expectedRevision:{type:'integer',minimum:0},title:{type:'string'},conversation:{type:'string'},outline:{type:'string'},action:{type:'string',enum:['add','update','remove']},id:{type:'string'},parent:{type:'string'},status:{type:'string',enum:['pending','active','done','blocked']},note:{type:'string'}};
const tools=[['plan_dashboard','Open saved plans from the conversation panel; choose the matching plan',[]],['plan_list','List saved plans',[]],['plan_view','Read a plan, current steps and progress; show interactive map',['planId']],['plan_import','Register an approved hierarchical plan. Existing plans require expectedRevision. Do not overwrite without approval.',['planId','outline']],['plan_node','Maintain node status, title or parent as work proceeds. Always read current revision before editing.',['planId','action','id','expectedRevision']]].map(([name,description,required])=>({name,description,inputSchema:{type:'object',properties:['plan_list','plan_dashboard'].includes(name)?{}:props,required,additionalProperties:false},annotations:{readOnlyHint:['plan_list','plan_view','plan_dashboard'].includes(name),destructiveHint:['plan_import','plan_node'].includes(name),openWorldHint:false},...(['plan_view','plan_dashboard'].includes(name)?{_meta:{ui:{resourceUri:uri},'openai/outputTemplate':uri,...(name==='plan_dashboard'?{'openai/ui':{entrypoints:[{type:'thread'}]}}:{})}}:{})}));
const web=http.createServer(async(req,res)=>{try{
 const origin='http://'+req.headers.host;if(origin!==url)throw Error('Invalid host');
 const parsed=new URL(req.url,url);res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(parsed.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html.replace('<head>','<head><meta name="plan-token" content="'+token+'">'));return;}
 if(['/app.js','/layout.js','/viewport.js'].includes(parsed.pathname)){res.setHeader('Content-Type','text/javascript');res.end(parsed.pathname==='/app.js'?client:parsed.pathname==='/layout.js'?layout:viewport);return;}
 if(parsed.pathname==='/api'&&req.method==='POST'){
 if(req.headers.origin!==url||req.headers['x-plan-token']!==token)throw Error('Request rejected');let body='';for await(const chunk of req){body+=chunk;if(body.length>70000)throw Error('Request too large');}const data=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await call(data.name,data.arguments||{})));return;}
 res.writeHead(404);res.end();
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
await new Promise(resolve=>web.listen(Number(process.env.PLAN_MAP_PORT||0),'127.0.0.1',resolve));url='http://127.0.0.1:'+web.address().port;
const server=new Server({name:'xinshi-plan-map',version:'0.3.2'},{capabilities:{tools:{},resources:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{try{const value=await call(params.name,params.arguments||{});return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});
server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri,name:'Plan Map',mimeType:'text/html;profile=mcp-app'}]}));
server.setRequestHandler(ReadResourceRequestSchema,async({params})=>{if(params.uri!==uri&&!['ui://xinshi-plan-map/v3.html','ui://xinshi-plan-map/v4.html'].includes(params.uri))throw Error('Unknown resource');return {contents:[{uri:params.uri,mimeType:'text/html;profile=mcp-app',text:widget,_meta:{ui:{prefersBorder:true}}}]};});
if(process.argv.includes('--web'))console.log(url);else await server.connect(new StdioServerTransport());
process.stdin.on('end',()=>{if(!process.argv.includes('--web')){web.close();process.exit(0);}});
