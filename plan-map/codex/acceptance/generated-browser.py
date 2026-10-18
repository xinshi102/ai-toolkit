"""Run the exact generated MCP resource in Chromium with an isolated host fixture.
This is regression coverage, not acceptance of the real desktop host.
"""
import json, os, pathlib, subprocess, tempfile
from playwright.sync_api import sync_playwright

root=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='map-generated-browser-') as tmp:
    script="""
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writeFile} from 'node:fs/promises';
const c=new Client({name:'generated-browser',version:'1.0'});
try {
 await c.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env}}));
 const p=(await c.callTool({name:'plan_import',arguments:{planId:'fixture',outline:'Project\\n  First\\n  Second'}})).structuredContent;
 const r=await c.readResource({uri:'ui://xinshi-plan-map/v8.html'});
 await writeFile(process.env.FIXTURE_DIR+'/widget.html',r.contents[0].text);
 await writeFile(process.env.FIXTURE_DIR+'/plan.json',JSON.stringify(p));
} finally {await c.close();}
"""
    subprocess.run(['node','--input-type=module','-e',script],cwd=root,env=dict(os.environ,PLAN_MAP_HOME=tmp,FIXTURE_DIR=tmp),check=True)
    plan=json.loads((pathlib.Path(tmp)/'plan.json').read_text(encoding='utf8'))
    widget=(pathlib.Path(tmp)/'widget.html').read_text(encoding='utf8')
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':480,'height':900})
        errors=[]
        page.on('pageerror',lambda error: errors.append(str(error)))
        page.set_content('<html><body><iframe id="widget" style="width:440px;height:850px;border:0"></iframe></body></html>')
        page.evaluate("""({plan,widget})=>{
          window.hostCalls=[];
          window.addEventListener('message',e=>{
            const m=e.data;if(!m.id)return;
            hostCalls.push(m.method+':'+(m.params?.name||''));
            let result={};
            if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'test',version:'1.0'},hostCapabilities:{}};
            if(m.method==='tools/call'){
              const name=m.params.name;
              result={structuredContent:name==='plan_list'?{plans:[plan]}:name==='plan_history'?{history:[]}:plan};
            }
            e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
          });
          document.getElementById('widget').srcdoc=widget;
        }""",{'plan':plan,'widget':widget})
        frame=page.frame_locator('#widget')
        frame.locator('[data-node]').first.wait_for()
        frame.locator('#more').click()
        frame.locator('#history').click()
        page.wait_for_function("window.hostCalls.includes('tools/call:plan_history')")
        calls=page.evaluate('window.hostCalls')
        assert any(c=='tools/call:plan_view' for c in calls),calls
        assert any(c=='tools/call:plan_history' for c in calls),calls
        assert not errors,errors
        print(json.dumps({'generatedInlineResource':'PASS','handshakeAndPlanRender':'PASS','historyToolRoundTrip':'PASS','errors':errors,'actualDesktopAccepted':False}))
        browser.close()
