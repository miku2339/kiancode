import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { BrowserToolProvider, probeBrowserAutomation } from '../src/tools/browser.js';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('browser tools navigate, snapshot, fill, and click a configured localhost fixture', async (t) => {
  try { await access(chrome); } catch { t.skip('No configured Chromium executable available'); return; }
  const health = await probeBrowserAutomation(chrome);
  if (!health.available) { t.skip(`Chromium cannot launch: ${health.reason}`); return; }

  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Fixture</title><label>Name <input id="name"></label><button id="save" onclick="document.body.dataset.saved=document.querySelector(\'#name\').value">Save</button>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const provider = await BrowserToolProvider.launch({ permission: 'configured', executablePath: chrome, allowedOrigins: [origin] });
  const tools = new Map(provider.tools().map((tool) => [tool.name, tool]));
  const context = {
    principal: { id: 'user-1', level: 4 as const, scopes: ['browser:automation'] },
    taskId: 'task-1', signal: new AbortController().signal,
  };
  try {
    await tools.get('browser.navigate')!.execute({ url: origin }, context);
    await tools.get('browser.fill')!.execute({ selector: '#name', value: 'Kian' }, context);
    await tools.get('browser.click')!.execute({ selector: '#save' }, context);
    const snapshot = JSON.parse((await tools.get('browser.snapshot')!.execute({}, context)).content) as { title: string; visibleText: string };
    assert.equal(snapshot.title, 'Fixture');
    assert.match(snapshot.visibleText, /Name/);
    await assert.rejects(tools.get('browser.navigate')!.execute({ url: 'https://example.com' }, context), /origin/i);
  } finally {
    await provider.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
