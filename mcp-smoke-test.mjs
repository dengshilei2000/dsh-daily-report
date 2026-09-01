// MCP smoke test for the daily-report plugin's MCP server.
//
// Spins a plain node:http server wired to the plugin's real MCP route handler,
// drives it with the official MCP SDK client, and verifies the full wire path:
// initialize -> tools/list -> tools/call for generate/get/list/send.
//
// The plugin's OS/model boundaries are stubbed: the `llm` service returns one
// canned JSON report, the `shell` service fakes PowerShell (docx write,
// dws contact search, dws chat send). Everything else — zod schemas, JSON-RPC,
// Streamable HTTP transport, SSE negotiation — is the real implementation.
//
// Run: node mcp-smoke-test.mjs   (expect exit 0)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountMcpServer, MCP_PATH } from './lib/mcp-server.js';

const CANNED_REPORT = JSON.stringify({
  todayCompleted: '1. 完成 MCP Server 接入\n2. 编写冒烟测试',
  tomorrowPlan: '1. 补充 e2e 测试\n2. 完善 README',
  insights: '今日完成了日报插件的 MCP Server 化改造，理解了 Streamable HTTP 的无状态会话模型，并验证了工具调用全链路。',
});

function fakeShell() {
  return {
    resolve(spec) {
      return { ...spec };
    },
    async run(spec) {
      const command = spec.command;
      if (command.includes('WriteAllBytes')) {
        const m = command.match(/Join-Path \$d '([^']+)'/);
        const name = m ? m[1] : '日报.docx';
        const dir = 'daily-reports';
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, name), Buffer.from(spec.stdin || '', 'base64'));
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, sandbox: undefined };
      }
      if (command.includes('contact user search')) {
        return {
          exitCode: 0,
          stdout: { text: JSON.stringify({ result: [{ userId: 'u123', name: '张三' }] }) },
          stderr: { text: '' },
          sandbox: undefined,
        };
      }
      if (command.includes('chat message send')) {
        return {
          exitCode: 0,
          stdout: { text: JSON.stringify({ success: true, messageId: 'm1' }) },
          stderr: { text: '' },
          sandbox: undefined,
        };
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, sandbox: undefined };
    },
  };
}

function stubCtx() {
  return {
    get(name) {
      if (name === 'shell') return fakeShell();
      if (name === 'sandboxPolicy') {
        return { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '.' }) };
      }
      if (name === 'llm') {
        return {
          async *stream() {
            yield { type: 'text-delta', text: CANNED_REPORT };
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

function assert(cond, label) {
  if (!cond) throw new Error('FAIL: ' + label);
  console.log('  ok - ' + label);
}

async function main() {
  const { handler } = mountMcpServer(stubCtx());

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      console.error('route error', e);
      if (!res.headersSent) {
        res.writeHead(500).end(String(e && e.message ? e.message : e));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = 'http://127.0.0.1:' + port + MCP_PATH;
  console.log('MCP endpoint:', url);

  const client = new Client({ name: 'drp-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  console.log('  ok - initialize + connect');

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) ===
      JSON.stringify(['generate_report', 'get_report', 'list_reports', 'send_report']),
    'tools/list exposes the four tools, got ' + JSON.stringify(names),
  );
  const genTool = tools.tools.find((t) => t.name === 'generate_report');
  assert(
    genTool && genTool.inputSchema && genTool.inputSchema.properties &&
      genTool.inputSchema.properties.morningMaterials,
    'generate_report inputSchema carries morningMaterials',
  );

  const gen = await client.callTool({
    name: 'generate_report',
    arguments: { morningMaterials: '上午学习了 MCP Streamable HTTP 协议' },
  });
  const genText = gen.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const genData = JSON.parse(genText);
  assert(!!genData.reportId, 'generate_report returns reportId (' + genData.reportId + ')');
  assert(genData.todayCompleted.includes('1. 完成 MCP Server 接入'), 'todayCompleted from model text');
  assert(!!genData.relativePath, 'generate_report returns relativePath');
  assert(genData.downloadBase64.length > 500, 'downloadBase64 carries a real docx');

  const get = await client.callTool({
    name: 'get_report',
    arguments: { reportId: genData.reportId },
  });
  const getText = get.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const getData = JSON.parse(getText);
  assert(getData.reportId === genData.reportId, 'get_report round-trips reportId');
  assert(getData.insights.includes('Streamable HTTP'), 'get_report returns insights body');

  const list = await client.callTool({ name: 'list_reports', arguments: {} });
  const listText = list.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const listData = JSON.parse(listText);
  assert(Array.isArray(listData) && listData.some((r) => r.reportId === genData.reportId), 'list_reports contains the new report');

  const send = await client.callTool({
    name: 'send_report',
    arguments: { reportId: genData.reportId, recipient: '张三' },
  });
  const sendText = send.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const sendData = JSON.parse(sendText);
  assert(sendData.ok === true && sendData.userId === 'u123', 'send_report resolves唯一好友并发送');

  // send_report must refuse unknown reportIds: the tool throws, which the MCP
  // protocol surfaces as an isError result rather than a client rejection.
  const missing = await client.callTool({
    name: 'send_report',
    arguments: { reportId: 'report-missing', recipient: '张三' },
  });
  const missingText = missing.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  assert(missing.isError === true && missingText.includes('找不到该日报'), 'send_report rejects unknown reportId');

  await client.close();
  await new Promise((resolve) => server.close(resolve));
  console.log('PASS');
}

main().catch((error) => {
  console.error('SMOKE TEST FAILED:', error && error.message ? error.message : error);
  process.exit(1);
});
