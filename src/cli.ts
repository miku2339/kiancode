#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootstrap } from './bootstrap.js';
import { loadConfig } from './config.js';
import { createBlobServer } from './http/blob-server.js';
import { runConnector } from './connector-cli.js';

function flag(name: string, fallback: string): string { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; }

async function main() {
  const command = process.argv[2] ?? 'help';
  const configFile = flag('--config', '.runtime/config.json');
  if (command === 'connector') { await runConnector(configFile); return; }
  if (command === 'blobs') {
    const key = flag('--tls-key', ''); const cert = flag('--tls-cert', '');
    if (Boolean(key) !== Boolean(cert)) throw new Error('Provide both --tls-key and --tls-cert');
    const tokenFile = flag('--token-file', '');
    const token = process.env.KIANCODE_BLOB_TOKEN ?? (tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : '');
    const app = createBlobServer({ directory: flag('--directory', '.runtime/attachments'), token, ...(key ? { tls: { key: await readFile(key), cert: await readFile(cert) } } : {}) });
    process.stdout.write(`Attachment service listening at ${await app.listen({ host: flag('--host', '127.0.0.1'), port: Number(flag('--port', '8769')) })}\n`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close(); });
    return;
  }
  if (command === 'init') {
    await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
    await writeFile(configFile, JSON.stringify({ mode: 'development', host: '127.0.0.1', port: 8768, auth: { developmentTokenEnv: 'KIANCODE_DEV_TOKEN' }, providers: [], models: [], serverWorkspaceRoots: [] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(path.dirname(configFile), 'development.env'), `KIANCODE_DEV_TOKEN=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Created ${configFile}. Add a provider and model, then run kiancode serve.\n`); return;
  }
  if (command === 'serve') {
    const envFile = path.join(path.dirname(configFile), 'development.env');
    const config = await loadConfig(configFile);
    if (config.mode === 'development') {
      try { process.loadEnvFile(envFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const server = await bootstrap(config);
    const address = await server.app.listen({ host: config.host, port: config.port });
    process.stdout.write(`kiancode listening at ${address}\n`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
      if (stopping) return; stopping = true;
      void server.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
    });
    return;
  }
  if (command === 'chat') {
    const prompt = flag('--message', '');
    if (!prompt) throw new Error('Use --message with a prompt');
    const endpoint = flag('--url', 'http://127.0.0.1:8768');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote servers require HTTPS');
    if (!process.env.KIANCODE_TOKEN) {
      try { process.loadEnvFile(path.join(path.dirname(configFile), 'development.env')); } catch {}
    }
    const token = process.env.KIANCODE_TOKEN ?? process.env.KIANCODE_DEV_TOKEN;
    if (!token) throw new Error('Set KIANCODE_TOKEN to your session token');
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const send = async (route: string, body?: unknown) => {
      const result = await fetch(new URL(route, endpoint), { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!result.ok) throw new Error(`Server returned HTTP ${result.status}: ${await result.text()}`);
      return result.json() as Promise<{ data: { id: string; data: { state: string; result?: string; error?: string } } }>;
    };
    let conversationId = flag('--conversation', '');
    if (!conversationId) conversationId = (await send('/v1/conversations', { title: prompt.slice(0, 80), mode: flag('--mode', 'ask'), modelPolicy: flag('--model-policy', 'cloud') })).data.id;
    const task = await send(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`, { content: prompt, requestId: randomBytes(16).toString('hex') });
    process.stdout.write(`Conversation: ${conversationId}\nTask: ${task.data.id}\n`);
    let sequence = 0;
    while (true) {
      const response = await fetch(new URL(`/v1/tasks/${task.data.id}/stream?after=${sequence}`, endpoint), { headers, redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!response.ok || !response.body) throw new Error(`Stream returned HTTP ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          for (const line of event.split('\n')) {
            if (line.startsWith('id: ')) sequence = Number(line.slice(4));
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6)) as { type?: string; payload?: { content?: string } };
              if (data.type === 'token') process.stdout.write(data.payload?.content ?? '');
            }
          }
        }
      }
      const current = await send(`/v1/tasks/${task.data.id}`);
      if (!['queued', 'running'].includes(current.data.data.state)) {
        process.stdout.write(`\n${current.data.data.state}${current.data.data.error ? `: ${current.data.data.error}` : ''}\n`); break;
      }
    }
    return;
  }
  if (command === 'config-check') { await loadConfig(configFile); process.stdout.write('Configuration valid\n'); return; }
  if (command === 'version') { const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }; process.stdout.write(`${pkg.version}\n`); return; }
  process.stdout.write('kiancode init | serve [--config path] | chat --message text [--conversation id] [--model-policy cloud|local|auto] | config-check | version\n');
}
main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`); process.exitCode = 1; });
