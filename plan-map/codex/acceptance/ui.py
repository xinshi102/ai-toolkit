"""Isolated local-app acceptance; never uses the user's saved plans or browser profile."""
import os, pathlib, tempfile, subprocess, queue, threading, shutil, json
from playwright.sync_api import sync_playwright
root=pathlib.Path(__file__).resolve().parents[1]
node=os.environ.get('NODE_BINARY') or shutil.which('node')
if not node: raise RuntimeError('Set NODE_BINARY or add Node.js to PATH')
with tempfile.TemporaryDirectory(prefix='plan-map-ui-') as temp:
    env={**os.environ,'PLAN_MAP_HOME':temp}
    seed="import {Store}from './store.js';await new Store(process.env.PLAN_MAP_HOME).import("+json.dumps({'planId':'ui','outline':'# 项目\n- 设计\n- 验收'})+");"
    subprocess.run([node,'--input-type=module','-e',seed],cwd=root,env=env,check=True)
    proc=subprocess.Popen([node,'server.js','--web'],cwd=root,env=env,stdout=subprocess.PIPE,text=True,encoding='utf-8')
    try:
        urls=queue.Queue()
        threading.Thread(target=lambda: urls.put(proc.stdout.readline().strip()),daemon=True).start()
        url=urls.get(timeout=15)
        assert url.startswith('http://127.0.0.1:'),'server startup failed'
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='chrome',headless=True)
            page=browser.new_page(viewport={'width':425,'height':740})
            page.goto(url+'/?plan=ui')
            page.get_by_role('button',name='项目 pending',exact=True).wait_for()
            assert not page.get_by_role('button',name='刷新',exact=True).is_visible()
            assert not page.locator('#details').is_visible()
            page.get_by_role('button',name='导图选项').click()
            page.get_by_role('button',name='全部折叠',exact=True).click()
            assert page.get_by_role('button',name='设计 pending',exact=True).count()==0
            page.get_by_role('button',name='全部展开',exact=True).click()
            page.get_by_role('button',name='纵向',exact=True).click()
            assert page.locator('#vertical').get_attribute('aria-pressed')=='true'
            page.keyboard.press('Escape');page.locator('#options').wait_for(state='hidden')
            page.get_by_role('button',name='设计 pending',exact=True).click()
            assert page.locator('#details').is_visible()
            card=page.locator('#details').bounding_box(); graph=page.locator('#canvas').bounding_box()
            assert card['width']<=210 and card['height']<=120
            assert card['y']>=graph['y']+graph['height']-1, 'detail must not cover graph'
            page.locator('#editDetails summary').click()
            page.get_by_label('状态',exact=True).select_option('active')
            page.get_by_role('button',name='保存修改',exact=True).click()
            page.get_by_role('button',name='设计 active',exact=True).wait_for()
            assert page.locator('#current').inner_text()=='当前：设计'
            page.reload();page.get_by_role('button',name='设计 active',exact=True).wait_for()
            assert page.locator('#vertical').get_attribute('aria-pressed')=='true'
            browser.close()
        print('PASS: hidden controls/details, menu, collapse/expand, direction persistence, edit/save/reload')
    finally:
        proc.terminate();proc.wait(timeout=10)
        proc.stdout.close()
