// Web route integration test: mounts makeRoutes() from lib/index.js on a plain
// node:http server with a stubbed ctx (fake llm + fake shell writing real
// .docx bytes into a temp workdir), then exercises the HTTP API end to end:
//   generate-report -> rebuild-file (edited text) -> ledger updated
// plus the rebuild-file error paths.
//
// Run: node web-routes-test.mjs   (expect exit 0)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRoutes, outputs } from './lib/index.js';

const CANNED = JSON.stringify({
  todayCompleted: '1. 完成接入\n2. 写了测试',
  tomorrowPlan: '1. 继续完善',
  insights: '今日完成了 B1 可编辑功能的实现。',
});

function assert(cond, label) {
  if (!cond) throw new Error('FAIL: ' + label);
  console.log('  ok - ' + label);
}

function fakeShell(workdir) {
  return {
    resolve(spec) { return spec; },
    async run(spec) {
      const cmd = spec.command;
      if (cmd.includes('WriteAllBytes')) {
        const m = cmd.match(/Join-Path \$d '([^']+)'/);
        const name = m ? m[1] : 'x.docx';
        const dir = path.join(workdir, 'daily-reports');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), Buffer.from(spec.stdin || '', 'base64'));
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, sandbox: undefined };
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, sandbox: undefined };
    },
  };
}

function stubCtx(workdir) {
  return {
    get(name) {
      if (name === 'shell') return fakeShell(workdir);
      if (name === 'llm') {
        return {
          async *stream() {
            yield { type: 'text-delta', text: CANNED };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test', model: 'test-model' }) };
      }
      return undefined;
    },
  };
}

async function main() {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'drp-routes-'));
  const routes = makeRoutes(stubCtx(workdir));

  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    const route = routes.find((r) => r.kind === 'exact' && r.path === pathname);
    if (!route) { res.writeHead(404).end('not found'); return; }
    route.handler(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500).end(String(e && e.message ? e.message : e));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + '/api/daily-report';

  async function post(p, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body || {});
      const req = http.request(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(out); } catch { /* ignore */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // 1. generate
  const gen = await post('/generate-report', { morningMaterials: '上午完成了 B1 接入' });
  assert(gen.status === 200 && gen.json && gen.json.ok, 'generate-report returns ok');
  assert(!!gen.json.id && !!gen.json.file.downloadBase64 && gen.json.file.downloadBase64.length > 500, 'generate-report returns id + docx base64');
  const id = gen.json.id;
  const originalPath = gen.json.file.relativePath;

  // 2. rebuild with edited text
  const edited = {
    todayCompleted: '1. 用户改写的完成项\n2. 增加了一条',
    tomorrowPlan: '1. 用户改写的计划',
    insights: '用户补充的感悟。',
  };
  const rb = await post('/rebuild-file', { id, report: edited });
  assert(rb.status === 200 && rb.json && rb.json.ok, 'rebuild-file returns ok');
  assert(rb.json.report.todayCompleted === edited.todayCompleted, 'rebuild-file echoes edited section');
  assert(rb.json.file.relativePath !== originalPath, 'rebuild-file writes a fresh unique file');
  assert(rb.json.file.downloadBase64 !== gen.json.file.downloadBase64, 'rebuild-file returns different docx bytes');
  const ledger = outputs.get(id);
  assert(ledger && ledger.report.todayCompleted === edited.todayCompleted, 'ledger entry updated with edited text');

  // 3. rebuild with an empty section -> 400
  const bad = await post('/rebuild-file', { id, report: { todayCompleted: '1. x', tomorrowPlan: '', insights: 'y' } });
  assert(bad.status === 400 && bad.json && bad.json.error && bad.json.error.includes('不能为空'), 'rebuild-file rejects empty section');

  // 4. rebuild with unknown id -> 400
  const unknown = await post('/rebuild-file', { id: 'report-missing', report: edited });
  assert(unknown.status === 400 && unknown.json && unknown.json.error && unknown.json.error.includes('找不到'), 'rebuild-file rejects unknown id');

  // 5. generate with empty materials -> 400
  const empty = await post('/generate-report', { morningMaterials: '', afternoonMaterials: '' });
  assert(empty.status === 400, 'generate-report rejects empty materials');

  await new Promise((r) => server.close(r));
  fs.rmSync(workdir, { recursive: true, force: true });
  console.log('PASS');
}

main().catch((error) => {
  console.error('WEB ROUTES TEST FAILED:', error && error.message ? error.message : error);
  process.exit(1);
});
