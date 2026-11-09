import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPublishDiscovery } from '../lib/index.js';

test('headless profiles do not replace desktop discovery',()=>{
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile','headless','--json','-']),false);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile=headless','--json','-']),false);
});
test('only explicit desktop and web processes publish discovery',()=>{
 assert.equal(shouldPublishDiscovery(['DeepSeek Harness','/app/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js','/Users/test/.dsh/profiles/desktop']),true);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile','web']),true);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile=web']),true);
 assert.equal(shouldPublishDiscovery(['node','--test']),false);
 assert.equal(shouldPublishDiscovery(['node','bin.js']),false);
 assert.equal(shouldPublishDiscovery(['node',String.raw`C:\app\dsh-desktop-host\lib\index.js`]),true);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile','headless-review']),false);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--patch','headless']),false);
});
