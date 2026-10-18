"""Real Chromium checks using synthetic plans and a private temporary server."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='plan-map-ui-') as temp:
    env = dict(os.environ, PLAN_MAP_HOME=temp)
    seed = """import {Store} from './store.js';
    const s=new Store(process.env.PLAN_MAP_HOME);
    await s.import({planId:'demo',title:'肉鸽游戏',outline:'肉鸽游戏\\n  策划\\n  Framework\\n    ECS\\n    Save\\n    UI\\n  Environment\\n  Coding\\n    Procedural Generation\\n      Room Generator\\n      Seed System\\n      Validation\\n  Test'});
    """
    subprocess.run(['node','--input-type=module','-e',seed],cwd=root,env=env,check=True)
    proc = subprocess.Popen(['node','server.js','--web'],cwd=root,env=env,stdout=subprocess.PIPE,text=True)
    try:
        url = proc.stdout.readline().strip()
        assert url.startswith('http://127.0.0.1:')
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width':425,'height':900},reduced_motion='reduce')
            errors=[]
            page.on('pageerror',lambda error: errors.append(str(error)))
            page.goto(url+'/?plan=demo')
            page.locator('[data-node]').first.wait_for()
            page.locator('#more').click()
            page.locator('#expand').click()
            page.locator('#plus').click()
            page.locator('#minus').click()
            page.locator('#size').click()
            assert page.locator('#canvas').evaluate('(e)=>e.clientHeight') > 280
            # Preference restoration must survive a real page reload.
            page.locator('#compact').click()
            page.reload()
            page.locator('[data-node]').first.wait_for()
            page.locator('#more').click()
            assert page.locator('#compact').get_attribute('aria-pressed') == 'true'
            page.locator('#compact').click()
            page.locator('#more').click()
            leaf = page.locator('[data-node]').filter(has_text='ECS').first
            leaf.dblclick()
            page.locator('.pm-rename').fill('ECS 架构')
            page.locator('.pm-rename').press('Enter')
            page.wait_for_function("document.querySelector('.pm-title') && [...document.querySelectorAll('.pm-title')].some(e=>e.textContent==='ECS 架构')")
            page.locator('[data-node]').filter(has_text='ECS 架构').first.click()
            page.locator('#editDetails summary').click()
            page.locator('#blockedReason').fill('等待架构评审')
            page.locator('#status').select_option('blocked')
            page.locator('#save').click()
            page.wait_for_function("document.querySelector('#note').textContent.includes('等待架构评审')")
            page.locator('#more').click()
            page.locator('#history').click()
            page.wait_for_function("document.querySelector('#detailTitle').textContent==='变更记录'")
            assert 'ECS 架构' in page.locator('#note').inner_text()
            page.locator('#more').click()
            page.locator('#closeDetail').click()
            for width in [425,360]:
                page.set_viewport_size({'width':width,'height':900})
                if page.locator('#more').get_attribute('aria-expanded') != 'true':
                    page.locator('#more').click()
                page.locator('#fit').click()
                page.locator('#more').click()
                assert page.locator('#canvas').evaluate('(e)=>e.scrollLeft') == 0
                page.screenshot(path=str(root.parent/f'preview-{width}.png'))
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert not errors, errors
            browser.close()
            print(json.dumps({'browser':'Chromium','widths':[425,360],'rename':'PASS','status_and_reason':'PASS','history':'PASS','preferences':'PASS','errors':errors}))
    finally:
        proc.terminate()
        proc.wait(timeout=10)
