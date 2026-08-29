// Headless browser E2E test for the daily-report upload path.
// Launches Chrome headless, loads the DSH GUI, opens the report panel,
// simulates a file pick, and reports console errors + DOM state.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9333;
const TARGET = 'http://127.0.0.1:3080/';

const tmpProfile = path.join(process.env.TEMP || '.', 'drp-chrome-' + Date.now());
fs.mkdirSync(tmpProfile, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--remote-debugging-port=' + DEBUG_PORT,
  '--user-data-dir=' + tmpProfile,
  '--window-size=1400,900',
  TARGET,
], { stdio: ['ignore', 'pipe', 'pipe'] });

let stderrBuf = '';
chrome.stderr.on('data', (d) => { stderrBuf += d.toString(); });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForDebugger() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson('http://127.0.0.1:' + DEBUG_PORT + '/json');
      if (list && list.length > 0) return list;
    } catch (e) { /* retry */ }
    await sleep(500);
  }
  throw new Error('debugger not ready; stderr=' + stderrBuf.slice(0, 500));
}

async function main() {
  const pages = await waitForDebugger();
  const page = pages.find((p) => p.type === 'page');
  if (!page) throw new Error('no page found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let msgId = 0;
  const pending = new Map();
  const consoleLogs = [];

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      consoleLogs.push('[console.' + msg.params.type + '] ' + args);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const text = d.exception ? d.exception.description : d.text;
      consoleLogs.push('[exception] ' + text);
    }
  };

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await send('Runtime.enable');
  await send('Page.enable');

  // Wait for the app to boot.
  await sleep(6000);

  // Check sidebar / floating entry presence.
  const probe1 = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hasFloat: !!document.querySelector('.drp-float'),
      hasSidebarEntry: !!document.querySelector('[data-dsh-daily-report-entry]'),
      hasRoot: !!document.querySelector('[data-dsh-daily-report-root]'),
      hasCss: !!document.querySelector('style[data-dsh-daily-report-css]'),
      drpSetOpen: typeof window.__drpSetOpen,
      drpToggle: typeof window.__drpToggle,
    })`,
    returnByValue: true,
  });
  console.log('PROBE-ENTRY:', probe1.result.result.value);

  // Open the panel via the floating button.
  await send('Runtime.evaluate', {
    expression: `(function(){ const b = document.querySelector('.drp-float'); if (b) { b.click(); return 'clicked'; } return 'no-float'; })()`,
    returnByValue: true,
  });
  await sleep(1200);

  const probe2 = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      overlay: !!document.querySelector('.drp-overlay'),
      panel: !!document.querySelector('.drp-panel'),
      fileInputs: document.querySelectorAll('.drp-file-input').length,
      textareas: document.querySelectorAll('.drp-textarea').length,
    })`,
    returnByValue: true,
  });
  console.log('PROBE-PANEL:', probe2.result.result.value);

  // Simulate picking a small file via the file input.
  const fileB64 = Buffer.from('濠碘槅鍨崜婵堚偓姘懄缁嬪绻濇担铏瑰€炲┑鐐存綑椤戝牓鎯侀鐐茬闁告侗鍙庨崯?ABC 123').toString('base64');
  const fileData = Buffer.from('濠碘槅鍨崜婵堚偓姘懄缁嬪绻濇担铏瑰€炲┑鐐存綑椤戝牓鎯侀鐐茬闁告侗鍙庨崯?ABC 123', 'utf8').toString('base64');
  // Use DOM.setFileInputFiles via CDP.
  const tmpFile = path.join(tmpProfile, 'sample.txt');
  fs.writeFileSync(tmpFile, '濠碘槅鍨崜婵堚偓姘懄缁嬪绻濇担铏瑰€炲┑鐐存綑椤戝牓鎯侀鐐茬闁告侗鍙庨崯?ABC 123', 'utf8');

    // Probe: add native listeners to the first file input.
  await send('Runtime.evaluate', {
    expression: `(function(){
      const el = document.querySelector('.drp-file-input');
      if (!el) return 'no-input';
      window.__probeLog = [];
      el.addEventListener('change', function(){ window.__probeLog.push('native-change'); });
      el.addEventListener('click', function(){ window.__probeLog.push('native-click'); });
      return 'probe-attached';
    })()`,
    returnByValue: true,
  });

  const inputInfo = await send('Runtime.evaluate', {
    expression: `(function(){ const els = document.querySelectorAll('.drp-file-input'); return els.length ? els[0].getAttribute('data-cdp-test') || (els[0].id = 'drp-file-0') : 'none'; })()`,
    returnByValue: true,
  });

  // Find the node id of the first file input.
  const nodeRes = await send('DOM.getDocument', { depth: -1 });
  const rootNodeId = nodeRes.result.root.nodeId;
  const queryRes = await send('DOM.querySelector', { nodeId: rootNodeId, selector: '.drp-file-input' });
  const fileNodeId = queryRes.result.nodeId;
  console.log('FILE-NODE-ID:', fileNodeId);

  if (fileNodeId) {
    await send('DOM.setFileInputFiles', { nodeId: fileNodeId, files: [tmpFile] });
    console.log('SET FILE OK');

  // Inspect the input element's React props.
  const reactProps = await send('Runtime.evaluate', {
    expression: `(function(){
      const el = document.querySelector('.drp-file-input');
      if (!el) return 'no-input';
      const keys = Object.keys(el).filter(k => k.startsWith('__react'));
      const result = { keys: keys, propsKeys: [] };
      for (const k of keys) {
        const p = el[k];
        if (p && p.props) result.propsKeys = Object.keys(p.props);
        if (p && p.memoizedProps) result.memoizedKeys = Object.keys(p.memoizedProps);
      }
      return JSON.stringify(result);
    })()`,
    returnByValue: true,
  });
  console.log('REACT-PROPS:', reactProps.result.result.value);

  // Directly invoke the React onChange handler with a synthetic event.
  const directCall = await send('Runtime.evaluate', {
    expression: `(function(){
      const el = document.querySelector('.drp-file-input');
      if (!el) return 'no-input';
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactProps')) {
          const onChange = el[k].onChange;
          if (typeof onChange === 'function') {
            // Call it with a fake event carrying a File.
            const file = new File(['测试文件内容'], 'direct.txt', { type: 'text/plain' });
            const evt = { target: { files: [file], value: '' } };
            try { onChange(evt); return 'onChange-invoked'; } catch (e) { return 'onChange-error: ' + e.message; }
          }
        }
      }
      return 'no-onChange';
    })()`,
    returnByValue: true,
  });
  console.log('DIRECT-CALL:', directCall.result.result.value);
  await sleep(2500);
  const probeAfter = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      status: (document.querySelector('.drp-status') || {}).textContent || '',
      error: (document.querySelector('.drp-error') || {}).textContent || '',
      fileItems: document.querySelectorAll('.drp-file-item').length,
    })`,
    returnByValue: true,
  });
  console.log('PROBE-AFTER-DIRECT:', probeAfter.result.result.value);

  // Read the probe log.
  const probeLog = await send('Runtime.evaluate', {
    expression: `JSON.stringify(window.__probeLog || [])`,
    returnByValue: true,
  });
  console.log('PROBE-LOG:', probeLog.result.result.value);
  }

  await sleep(3000);

  const probe3 = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      status: (document.querySelector('.drp-status') || {}).textContent || '',
      error: (document.querySelector('.drp-error') || {}).textContent || '',
      fileItems: document.querySelectorAll('.drp-file-item').length,
      fileList: (document.querySelector('.drp-file-list') || {}).textContent || '',
    })`,
    returnByValue: true,
  });
  console.log('PROBE-UPLOAD:', probe3.result.result.value);

  console.log('CONSOLE-LOGS:');
  for (const line of consoleLogs) console.log('  ' + line);

  ws.close();
  chrome.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('TEST-FAIL:', e.message);
  console.error('CHROME-STDERR:', stderrBuf.slice(0, 800));
  try { chrome.kill(); } catch (_) {}
  process.exit(1);
});
