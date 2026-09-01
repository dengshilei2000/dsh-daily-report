// dsh-daily-report — MCP Server half.
//
// Exposes the plugin's daily-report capabilities as a standard MCP server over
// the Streamable HTTP transport, served by DSH's own webServer route registry
// (no extra port, loopback only). External MCP clients (Claude Desktop, Cursor,
// other agents, or DSH's own `@deepseek-ai/dsh-mcp-client`) point at
//   http://127.0.0.1:<web port>/api/daily-report/mcp
//
// The server is STATELESS: every HTTP request carries a fresh transport and no
// session is kept, so there is nothing to expire or leak. Long-running
// `tools/call` responses are streamed over SSE when the client asks for it.
//
// Shared business state deliberately lives in ./index.js (the same `outputs`
// registry and the same generate/save/send functions the HTTP API uses), so a
// report generated through MCP can be sent through the web panel and vice
// versa. Importing ./index.js only defines functions and Maps — `apply()` runs
// only when the DSH plugin loader activates the plugin, not on import.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod';

import {
  normalizeInput,
  createReportWithFiles,
  saveDocx,
  sendDingTalk,
  outputs,
  nextSequence,
  text,
} from './index.js';

/** Public MCP endpoint path (registered as an exact webServer route). */
export const MCP_PATH = '/api/daily-report/mcp';

const PLUGIN_VERSION = '0.2.0';

function jsonTextResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

/**
 * Build one standalone McpServer with the plugin's tool set.
 *
 * The SDK Protocol allows a single transport per server instance, and our
 * stateless Streamable HTTP flow creates a fresh transport per HTTP request,
 * so a fresh server is created per request too (the official stateless
 * example does the same). Tool registration is pure object/closure work —
 * cheap per request — and every request is fully isolated from the others.
 * Business state (the `outputs` registry) lives in ./index.js and is shared.
 */
function createServer(ctx) {
  const server = new McpServer(
    { name: 'dsh-daily-report', version: PLUGIN_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'generate_report',
    {
      title: '生成日报',
      description:
        '根据上午/下午工作素材生成三栏 Word 日报（今日完成工作 / 明日计划 / 感悟总结），' +
        '调用当前 DSH 模型生成正文并保存为 .docx。上午素材与下午素材至少提供一项。' +
        '返回 reportId（后续 get_report / send_report 使用）、文件日期与相对路径、三段正文，以及 downloadBase64（完整 .docx 的 base64，可直接下载）。',
      inputSchema: {
        morningMaterials: z
          .string()
          .optional()
          .describe('上午素材：学习文档、代码源码、会议纪要等混合文本'),
        afternoonMaterials: z
          .string()
          .optional()
          .describe('下午素材：学习文档、代码源码、会议纪要等混合文本'),
      },
    },
    async (args) => {
      const data = normalizeInput(args || {});
      const report = await createReportWithFiles(ctx, data, [], []);
      const file = await saveDocx(ctx, report);
      const id = 'report-' + String(nextSequence());
      outputs.set(id, { report, file });
      return jsonTextResult({
        reportId: id,
        date: file.date,
        relativePath: file.relativePath,
        todayCompleted: report.todayCompleted,
        tomorrowPlan: report.tomorrowPlan,
        insights: report.insights,
        downloadBase64: file.base64,
      });
    },
  );

  server.registerTool(
    'get_report',
    {
      title: '读取日报',
      description:
        '按 reportId 读取已生成日报的三段正文与文件信息。reportId 来自 generate_report 的返回值。',
      inputSchema: {
        reportId: z.string().describe('generate_report 返回的 reportId'),
      },
    },
    async (args) => {
      const id = text(args.reportId, '日报编号');
      const item = outputs.get(id);
      if (!item) throw new Error('找不到该日报，请先调用 generate_report');
      return jsonTextResult({
        reportId: id,
        date: item.file.date,
        relativePath: item.file.relativePath,
        todayCompleted: item.report.todayCompleted,
        tomorrowPlan: item.report.tomorrowPlan,
        insights: item.report.insights,
      });
    },
  );

  server.registerTool(
    'list_reports',
    {
      title: '列出日报',
      description:
        '列出本次 DSH 进程内已生成的日报（reportId + 日期 + 文件相对路径）。重启 DSH 后内存账本清空，历史文件仍在磁盘，但 reportId 失效。',
    },
    async () => {
      const items = [];
      for (const [id, entry] of outputs) {
        items.push({ reportId: id, date: entry.file.date, relativePath: entry.file.relativePath });
      }
      return jsonTextResult(items);
    },
  );

  server.registerTool(
    'send_report',
    {
      title: '发送日报到钉钉',
      description:
        '把已生成的日报 .docx 作为附件发送给钉钉好友。收件人姓名必须唯一匹配，查无此人或重名时停止发送（不猜测、不发送）。依赖本机 dws CLI。',
      inputSchema: {
        reportId: z.string().describe('generate_report 返回的 reportId'),
        recipient: z.string().describe('钉钉好友姓名，需精确唯一匹配'),
      },
    },
    async (args) => {
      const item = outputs.get(text(args.reportId, '日报编号'));
      if (!item) throw new Error('找不到该日报，请先调用 generate_report');
      const result = await sendDingTalk(ctx, args.recipient, item.file);
      return jsonTextResult(result);
    },
  );

  return server;
}

/**
 * Create the MCP endpoint for one plugin context: the route to register and a
 * disposer for teardown. Stateless Streamable HTTP — every request gets its own
 * server + transport, so nothing is long-lived and there is nothing to dispose
 * at plugin teardown beyond the route itself.
 */
export function mountMcpServer(ctx) {
  // Stateless Streamable HTTP: one fresh transport (and one fresh server) per
  // request, no session id, nothing to expire or leak.
  const handler = async (req, res) => {
    let transport = null;
    let server = null;
    try {
      server = createServer(ctx);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
            id: null,
          }),
        );
      }
    } finally {
      res.on('close', () => {
        if (transport) transport.close().catch(() => {});
        if (server) server.close().catch(() => {});
      });
    }
  };

  return {
    path: MCP_PATH,
    handler,
    dispose: () => {
      // Nothing is long-lived: each request owns its server and transport.
    },
  };
}
