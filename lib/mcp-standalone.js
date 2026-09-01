#!/usr/bin/env node
// dsh-daily-report — standalone MCP Server (stdio transport).
//
// Runs the SAME four tools as the DSH-embedded server (generate_report /
// get_report / list_reports / send_report) but as an independent process, so
// clients like Codex CLI can use them WITHOUT DSH running. The shared tool
// implementations come from ./mcp-server.js (createServer) — only the context
// adapters differ: the LLM is called directly through an OpenAI-compatible
// chat completions API, files are written by spawning the local PowerShell /
// pwsh (the same scripts the DSH host runs), and DingTalk still goes through
// the local `dws` CLI.
//
// Configuration (environment variables):
//   DAILY_REPORT_API_KEY     DeepSeek API key (fallback: DEEPSEEK_API_KEY)  [required for generate_report]
//   DAILY_REPORT_API_BASE    OpenAI-compatible base URL, default https://api.deepseek.com
//   DAILY_REPORT_MODEL       model name, default deepseek-chat
//   DAILY_REPORT_WORKDIR     where daily-reports/ is written, default = process cwd
//
// Usage:
//   node lib/mcp-standalone.js
//   dsh-daily-report-mcp   (after `npm install -g .` / linking the bin)

import { spawn } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './mcp-server.js';

const env = (name) => {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
};

const CONFIG = {
  apiKey: env('DAILY_REPORT_API_KEY') || env('DEEPSEEK_API_KEY'),
  apiBase: String(env('DAILY_REPORT_API_BASE') || 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: env('DAILY_REPORT_MODEL') || 'deepseek-chat',
  reasoningEffort: env('DAILY_REPORT_REASONING_EFFORT'),
  workdir: env('DAILY_REPORT_WORKDIR'),
};

if (CONFIG.workdir) {
  try {
    process.chdir(CONFIG.workdir);
  } catch (error) {
    console.error('[dsh-daily-report-mcp] cannot chdir to DAILY_REPORT_WORKDIR=' + CONFIG.workdir + ': ' + (error && error.message ? error.message : error));
  }
}

// ---------------------------------------------------------------------------
// LLM adapter: OpenAI-compatible streaming chat completions, re-emitted in the
// chunk shape ./index.js's createReport() expects (text-delta / finish).
// ---------------------------------------------------------------------------

function finishError(message) {
  return { type: 'finish', reason: { kind: 'error', failure: { message } } };
}

async function* llmStream(options) {
  if (!CONFIG.apiKey) {
    yield finishError('缺少 DeepSeek API Key：请设置环境变量 DAILY_REPORT_API_KEY（或 DEEPSEEK_API_KEY）');
    return;
  }
  const first = options.messages && options.messages[0];
  const content = first && first.content;
  const userText = Array.isArray(content)
    ? content.map((c) => (c && c.type === 'text' ? c.text : '')).join('')
    : String(content || '');
  const body = {
    model: CONFIG.model,
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: userText },
    ],
    stream: true,
    max_tokens: options.maxTokens || 10000,
    temperature: options.temperature !== undefined ? options.temperature : 0.3,
  };
  let response;
  try {
    response = await fetch(CONFIG.apiBase + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CONFIG.apiKey },
      body: JSON.stringify(body),
    });
  } catch (error) {
    yield finishError('模型 API 请求失败：' + (error && error.message ? error.message : String(error)));
    return;
  }
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch { /* ignore */ }
    yield finishError('模型 API 返回 ' + response.status + '：' + detail.slice(0, 500));
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishKind = 'stop';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        const choice = parsed.choices && parsed.choices[0];
        if (!choice) continue;
        const delta = choice.delta && choice.delta.content;
        if (typeof delta === 'string' && delta) yield { type: 'text-delta', text: delta };
        if (choice.finish_reason === 'length') finishKind = 'max-tokens';
      }
    }
  } catch (error) {
    yield finishError('模型流读取中断：' + (error && error.message ? error.message : String(error)));
    return;
  }
  yield { type: 'finish', reason: { kind: finishKind === 'max-tokens' ? 'max-tokens' : 'stop' } };
}

// ---------------------------------------------------------------------------
// Shell adapter: runs the same PowerShell / pwsh scripts the DSH host would
// run (docx write, dws CLI), so saveDocx / sendDingTalk work unchanged.
// ---------------------------------------------------------------------------

function runShell(command, stdin) {
  return new Promise((resolve) => {
    const exe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    let child;
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        windowsHide: true,
      });
    } catch (error) {
      resolve({ exitCode: 1, stdout: { text: '' }, stderr: { text: error && error.message ? error.message : String(error) }, sandbox: undefined });
      return;
    }
    let out = '';
    let err = '';
    const cap = 4000000;
    child.stdout.on('data', (d) => { out += d.toString(); if (out.length > cap) out = out.slice(-cap); });
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > cap) err = err.slice(-cap); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 300000);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: { text: out }, stderr: { text: err || e.message }, sandbox: undefined });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code == null ? 1 : code, stdout: { text: out }, stderr: { text: err }, sandbox: undefined });
    });
    if (stdin !== undefined && stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

const shell = {
  resolve(spec) {
    return spec;
  },
  async run(spec) {
    return runShell(spec.command, spec.stdin);
  },
};

// ---------------------------------------------------------------------------
// Context adapter + bootstrap
// ---------------------------------------------------------------------------

const ctx = {
  get(name) {
    if (name === 'llm') return { stream: (options) => llmStream(options) };
    if (name === 'agentDefaultModel') {
      return {
        currentSelection: () => ({
          provider: 'standalone',
          model: CONFIG.model,
          reasoningEffort: CONFIG.reasoningEffort,
        }),
      };
    }
    if (name === 'shell') return shell;
    return undefined; // sandboxPolicy may be absent; shellRun falls back to a default
  },
};

const server = createServer(ctx);
const transport = new StdioServerTransport();

console.error(
  '[dsh-daily-report-mcp] ready · model=' + CONFIG.model +
  ' · api=' + CONFIG.apiBase +
  ' · workdir=' + process.cwd() +
  ' · apiKey=' + (CONFIG.apiKey ? 'set' : 'MISSING (generate_report will fail)'),
);

await server.connect(transport);

process.on('SIGINT', async () => {
  try { await server.close(); } catch { /* ignore */ }
  process.exit(0);
});
