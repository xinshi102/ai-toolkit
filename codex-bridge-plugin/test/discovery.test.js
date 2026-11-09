import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPublishDiscovery } from '../lib/index.js';

test('headless profiles do not replace desktop discovery',()=>{
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile','headless','--json','-']),false);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile=headless','--json','-']),false);
});
test('desktop, web and unrelated argument values keep discovery',()=>{
 assert.equal(shouldPublishDiscovery(['DeepSeek Harness','dsh-desktop-host/lib/index.js','/Users/test/.dsh/profiles/desktop']),true);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile','web']),true);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--profile','headless-review']),true);
 assert.equal(shouldPublishDiscovery(['node','bin.js','--patch','headless']),true);
});
