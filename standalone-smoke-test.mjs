// Standalone MCP smoke test: spawns lib/mcp-standalone.js as a child process,
// drives it over stdio JSON-RPC with the official wire protocol, against a
// MOCK OpenAI-compatible chat API (no real API credits, no DSH needed).
//
// Verifies: initialize -> tools/list -> generate_report (real PowerShell docx
// write into a temp workdir) -> get_report -> list_reports, plus the
// missing-API-key error path.
//
// Run: node standalone-smoke-test.mjs   (expect exit 0)

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STANDALONE = path.join(__dirname, 'lib', 'mcp-standalone.js');

const CANNED = '{"todayCompleted":"1. 完成独立 MCP Server 接入\\n2. 编写冒烟测试","tomorrowPlan":"1. 补充文档\\n2. 完善测试","insights":"今日完成了日报插件的独立 stdio MCP Server，验证了不经 DSH 直接调用日报工具的链路。"}';

function assert(cond, label) {
  if (!cond) throw new Error('FAIL: ' + label);
  console.log('  ok - ' + label);
}

function startMockApi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const mid = Math.floor(CANNED.length / 2);
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: CANNED.slice(0, mid) } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: CANNED.slice(mid) } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: CANNED } }] }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function startStandalone(extraEnv) {
  const child = spawn(process.execPath, [STANDALONE], {
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));
  return { child, stderr };
}

function waitReady(proc, ms = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const text = proc.stderr.join('');
      if (text.includes('ready')) { clearInterval(timer); resolve(); return; }
      if (Date.now() - started > ms) { clearInterval(timer); reject(new Error('standalone did not become ready: ' + text.slice(0, 400))); }
    }, 100);
  });
}

class StdioClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    child.stdout.on('data', (d) => {
      this.buffer += d.toString();
      let nl;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          p(msg);
        }
      }
    });
  }
  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
  }
}

function textOf(result) {
  return (result.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function main() {
  const mock = await startMockApi();
  const port = mock.address().port;
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'drp-standalone-'));
  console.log('mock API on 127.0.0.1:' + port + ' · workdir ' + workdir);

  const proc = startStandalone({
    DAILY_REPORT_API_BASE: 'http://127.0.0.1:' + port,
    DAILY_REPORT_API_KEY: 'test-key',
    DAILY_REPORT_MODEL: 'test-model',
    DAILY_REPORT_WORKDIR: workdir,
  });
  await waitReady(proc);
  const client = new StdioClient(proc.child);

  const init = await client.send('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'standalone-smoke', version: '1.0' },
  });
  assert(init.result && init.result.serverInfo && init.result.serverInfo.name === 'dsh-daily-report', 'initialize returns dsh-daily-report');
  client.notify('notifications/initialized', {});

  const tools = await client.send('tools/list', {});
  const names = tools.result.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(['generate_report', 'get_report', 'list_reports', 'send_report']),
    'tools/list exposes the four tools',
  );

  const gen = await client.send('tools/call', {
    name: 'generate_report',
    arguments: { morningMaterials: '上午完成了 MCP 集成' },
  });
  const genData = JSON.parse(textOf(gen.result));
  assert(!!genData.reportId, 'generate_report returns reportId (' + genData.reportId + ')');
  assert(genData.todayCompleted.includes('独立 MCP Server 接入'), 'todayCompleted from mock model text');
  assert(genData.downloadBase64 && genData.downloadBase64.length > 500, 'downloadBase64 carries a docx');

  const docDir = path.join(workdir, 'daily-reports');
  const docxFiles = fs.existsSync(docDir) ? fs.readdirSync(docDir) : [];
  assert(docxFiles.length === 1 && docxFiles[0].endsWith('.docx'), 'docx written via PowerShell into workdir: ' + JSON.stringify(docxFiles));

  const get = await client.send('tools/call', { name: 'get_report', arguments: { reportId: genData.reportId } });
  assert(JSON.parse(textOf(get.result)).reportId === genData.reportId, 'get_report round-trips reportId');

  const list = await client.send('tools/call', { name: 'list_reports', arguments: {} });
  assert(JSON.parse(textOf(list.result)).some((r) => r.reportId === genData.reportId), 'list_reports contains the new report');

  proc.child.kill();
  await new Promise((r) => proc.child.once('exit', r));

  // Missing API key must fail cleanly (isError, no crash).
  const proc2 = startStandalone({ DAILY_REPORT_API_KEY: '', DEEPSEEK_API_KEY: '', DAILY_REPORT_WORKDIR: workdir });
  await waitReady(proc2);
  const client2 = new StdioClient(proc2.child);
  await client2.send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } });
  const fail = await client2.send('tools/call', { name: 'generate_report', arguments: { morningMaterials: 'x' } });
  const failText = textOf(fail.result);
  assert(fail.result.isError === true && failText.includes('API Key'), 'generate_report fails cleanly without API key');
  proc2.child.kill();
  await new Promise((r) => proc2.child.once('exit', r));

  await new Promise((r) => mock.close(r));
  fs.rmSync(workdir, { recursive: true, force: true });
  console.log('PASS');
}

main().catch((error) => {
  console.error('STANDALONE SMOKE TEST FAILED:', error && error.message ? error.message : error);
  process.exit(1);
});
