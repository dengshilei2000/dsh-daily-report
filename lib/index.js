// dsh-daily-report — Host half.
// Daily report assistant: two material boxes, three-section DOCX, DingTalk send.
// Exposes HTTP routes under /api/daily-report/* for the browser half, and an
// MCP Server (Streamable HTTP) under /api/daily-report/mcp for external MCP
// clients. Both faces share the same business state (outputs/uploads) below.

import { mountMcpServer } from './mcp-server.js'

const MAX_FIELD = 90000
const MAX_UPLOAD_BYTES = 104857600
const API_PREFIX = '/api/daily-report'

export const outputs = new Map()
const uploads = new Map()
let sequence = 0

/** Monotonic id counter shared by the HTTP API and the MCP server. */
export function nextSequence() {
  return ++sequence
}

export const name = 'daily-report'
export const inject = ['webServer']

export function apply(ctx) {
  const webServer = ctx.webServer
  const disposers = []
  for (const route of makeRoutes(ctx)) disposers.push(webServer.register(route))
  const mcp = mountMcpServer(ctx)
  disposers.push(webServer.register({ kind: 'exact', path: mcp.path, handler: mcp.handler }))
  disposers.push(mcp.dispose)
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
  })
}

function writeJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// Shared business helpers (kept identical to the previously verified logic)
// ---------------------------------------------------------------------------

export function text(value, label) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(label + ' 必须是文本')
  const clean = value.replace(/\u0000/g, '').trim()
  if (clean.length > MAX_FIELD) throw new Error(label + ' 最多可输入 ' + MAX_FIELD + ' 个字符')
  return clean
}

export function normalizeInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('输入格式无效')
  const morningMaterials = text(raw.morningMaterials, '上午素材')
  const afternoonMaterials = text(raw.afternoonMaterials, '下午素材')
  const hasUploads = (raw && typeof raw === 'object') &&
    ((Array.isArray(raw.morningUploadIds) && raw.morningUploadIds.length > 0) ||
     (Array.isArray(raw.afternoonUploadIds) && raw.afternoonUploadIds.length > 0))
  if (!morningMaterials && !afternoonMaterials && !hasUploads) throw new Error('请至少填写上午素材或下午素材，或上传文档/压缩包')
  return { morningMaterials, afternoonMaterials }
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function parseReport(raw) {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const body = fenced ? fenced[1] : trimmed
  let value
  try {
    value = JSON.parse(body)
  } catch (error) {
    const start = body.indexOf('{'), end = body.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('模型没有返回有效的日报 JSON')
    try {
      value = JSON.parse(body.slice(start, end + 1))
    } catch (inner) {
      throw new Error('模型返回的日报 JSON 无法解析')
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型返回结构无效')
  const todayCompleted = stripInlineLabel(stripSectionLabel(text(value.todayCompleted, '今日完成工作')))
  const tomorrowPlan = stripInlineLabel(stripSectionLabel(text(value.tomorrowPlan, '明日计划')))
  const insights = mergeNumberedParagraph(stripInlineLabel(stripSectionLabel(text(value.insights, '感悟总结'))))
  if (!todayCompleted || !tomorrowPlan || !insights) throw new Error('模型返回的三个日报版块不能为空')
  return { todayCompleted, tomorrowPlan, insights }
}

// Remove a leading section label line such as "今日完成：" / "明日计划：" /
// "感悟总结：" (or variants like "【今日完成工作】") so the body starts
// directly with the numbered points.
function stripSectionLabel(value) {
  const lines = String(value).split(/\r?\n/)
  while (lines.length > 0) {
    const first = lines[0].trim()
    if (first === '') { lines.shift(); continue }
    if (/^[【\[]?\s*(今日完成|明日计划|感悟总结|今日完成工作|明日工作计划|今日工作总结)[：:】\]]?\s*$/.test(first)) {
      lines.shift()
      continue
    }
    break
  }
  return lines.join('\n').trim()
}

// Remove inline category / reference labels that may prefix a numbered point,
// e.g. "1. 学习文档相关成果：xxx" -> "1. xxx", "1. 针对今日第 1 点：xxx" -> "1. xxx".
// Recognized labels: 学习文档相关成果 / 代码源码相关进展 / 会议纪要相关事项 /
// 针对今日第 N 点 / 针对第 N 点 / 今日第 N 点 (with optional colon or dash).
function stripInlineLabel(value) {
  const lines = String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const labelRe = /^(?:学习文档相关成果|代码源码相关进展|会议纪要相关事项|学习文档相关|代码源码相关|会议纪要相关|针对今日第\s*\d+\s*点|针对第\s*\d+\s*点|今日第\s*\d+\s*点)\s*[：:\-、]\s*/
  return lines.map((line) => {
    // Match "1. label：" or just "label：" at the start of a numbered line.
    const numbered = line.match(/^(\d+\s*[.)、]\s*)(.*)$/)
    if (numbered) {
      const rest = numbered[2].replace(labelRe, '')
      return numbered[1] + rest
    }
    return line.replace(labelRe, '')
  }).join('\n').trim()
}

// If the model still emits numbered points for a section that must read as a
// flowing paragraph (insights), merge them into one continuous paragraph:
// "1. 第一句 2. 第二句" -> "第一句；第二句". Only applies when the text looks
// like a numbered list (at least two numbered lines or a lone numbered line).
function mergeNumberedParagraph(value) {
  const lines = String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return ''
  const parts = []
  let sawNumber = false
  for (const line of lines) {
    const numbered = line.match(/^\d+\s*[.)、]\s*(.*)$/)
    if (numbered) {
      sawNumber = true
      parts.push(numbered[1])
    } else {
      parts.push(line)
    }
  }
  if (!sawNumber || parts.length < 1) return value.trim()
  return parts.join('；').replace(/；+$/, '') + '。'
}

function para(value) {
  const lines = String(value).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  return (lines.length ? lines : ['']).map((line) =>
    '<w:p><w:pPr><w:spacing w:after="80" w:line="360" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">' + xmlEscape(line) + '</w:t></w:r></w:p>').join('')
}

function heading(value) {
  return '<w:p><w:pPr><w:spacing w:before="260" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="1F4E78"/><w:sz w:val="32"/></w:rPr><w:t>' + xmlEscape(value) + '</w:t></w:r></w:p>'
}

function documentXml(report, date) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr><w:t>工作日报</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>' + xmlEscape(date) + '</w:t></w:r></w:p>' + heading('1. 今日完成工作') + para(report.todayCompleted) + heading('2. 明日计划') + para(report.tomorrowPlan) + heading('3. 感悟总结') + para(report.insights) + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'
}

function crc32(bytes) {
  let crc = -1
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return (crc ^ -1) >>> 0
}

function u16(value) { return [value & 255, (value >>> 8) & 255] }
function u32(value) { return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255] }

function join(parts) {
  let size = 0
  for (const part of parts) size += part.length
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}

function stamp() {
  const now = new Date()
  return {
    time: ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() >> 1) & 31),
    date: (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31),
  }
}

function zip(entries) {
  const encoder = new TextEncoder()
  const mark = stamp()
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = encoder.encode(entry.content)
    const crc = crc32(data)
    const local = new Uint8Array([80, 75, 3, 4, 20, 0, 0, 0, 0, 0, ...u16(mark.time), ...u16(mark.date), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0])
    const localPart = join([local, name, data])
    locals.push(localPart)
    const central = new Uint8Array([80, 75, 1, 2, 20, 0, 20, 0, 0, 0, 0, 0, ...u16(mark.time), ...u16(mark.date), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(offset)])
    centrals.push(join([central, name]))
    offset += localPart.length
  }
  const centralData = join(centrals)
  return join([...locals, centralData, new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0, ...u16(entries.length), ...u16(entries.length), ...u32(centralData.length), ...u32(offset), 0, 0])])
}

function docxBytes(report, date) {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>'
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'
  const coreProps = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>工作日报</dc:title><dc:creator>Daily Report Assistant</dc:creator></cp:coreProperties>'
  const appProps = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Daily Report Assistant</Application></Properties>'
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>'
  return zip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rels },
    { name: 'docProps/core.xml', content: coreProps },
    { name: 'docProps/app.xml', content: appProps },
    { name: 'word/document.xml', content: documentXml(report, date) },
    { name: 'word/_rels/document.xml.rels', content: docRels },
    { name: 'word/styles.xml', content: styles },
  ])
}

function dateLabel() {
  const now = new Date()
  return String(now.getFullYear()) + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
}

function base64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    let part = ''
    for (let j = i; j < Math.min(i + 8192, bytes.length); j++) part += String.fromCharCode(bytes[j])
    binary += part
  }
  return btoa(binary)
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function safeName(value) {
  return String(value).replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 120) || 'file'
}

function b64Bytes(b64) {
  const s = String(b64 || '').replace(/=+$/, '')
  return Math.floor(s.length * 3 / 4)
}

async function shellRun(ctx, command, workdir, stdin) {
  const shell = ctx.get('shell')
  if (shell === undefined) throw new Error('当前 Harness 未提供命令执行服务')
  const policy = ctx.get('sandboxPolicy')
  const resolved = policy === undefined ? { mode: 'danger-full-access', workspaceRoot: '.' } : policy.resolve({ mode: 'danger-full-access' })
  const spec = shell.resolve({ command, workdir, stdin, timeoutMs: 300000, stdoutMaxBytes: 4000000, sandboxPolicy: resolved })
  const result = await shell.run(spec)
  return {
    exitCode: result.exitCode,
    stdout: result.stdout && typeof result.stdout.text === 'string' ? result.stdout.text : '',
    stderr: result.stderr && typeof result.stderr.text === 'string' ? result.stderr.text : '',
    denied: !!(result.sandbox && result.sandbox.denied),
  }
}

function extractScript(target) {
  const L = []
  L.push('$ErrorActionPreference=' + quote('Stop'))
  L.push('$f=' + quote(target))
  L.push('$ext=[IO.Path]::GetExtension($f).ToLowerInvariant()')
  L.push('if($ext -eq ' + quote('.docx') + '){')
  L.push('Add-Type -AssemblyName System.IO.Compression.FileSystem')
  L.push('$zip=[IO.Compression.ZipFile]::OpenRead($f)')
  L.push('try{')
  L.push('$entry=$null')
  L.push("foreach($e in $zip.Entries){if(($e.FullName -replace '\\\\','/') -eq 'word/document.xml'){$entry=$e;break}}")
  L.push('if($entry){')
  L.push('$sr=New-Object IO.StreamReader($entry.Open(),[Text.Encoding]::UTF8)')
  L.push('try{$xml=$sr.ReadToEnd()}finally{$sr.Dispose()}')
  L.push("$xml=[regex]::Replace($xml,'</w:p>|</w:tr>',\"`n\")")
  L.push("$xml=[regex]::Replace($xml,'<[^>]+>','')")
  L.push('[Console]::Out.Write([Net.WebUtility]::HtmlDecode($xml))')
  L.push('}')
  L.push('}finally{$zip.Dispose()}')
  L.push('}')
  L.push("elseif($ext -eq '.doc'){[Console]::Out.Write('[不支持 .doc 老格式，请在 Word 中另存为 .docx 后重新上传]')}")
  const textExts = ['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.sql', '.html', '.css', '.scss', '.less', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.sh', '.bat', '.ps1', '.vue', '.svelte', '.php', '.rb', '.swift', '.kt', '.properties'].map(function (e) { return quote(e) }).join(',')
  L.push('elseif($ext -in @(' + textExts + ')){')
  L.push('[IO.File]::ReadAllText($f,[Text.Encoding]::UTF8)')
  L.push('}')
  L.push("else{[Console]::Out.Write('[unhandled file type: '+$ext+']')}")
  return L.join('\n')
}

async function extractTextFromTarget(ctx, target) {
  const r = await shellRun(ctx, extractScript(target), '.')
  if (r.denied) throw new Error('文件解析被沙箱策略拒绝')
  if (r.exitCode !== 0) throw new Error('文件解析失败：' + (r.stderr || 'exit ' + String(r.exitCode)))
  return r.stdout
}

async function ingestUpload(ctx, period, fileName, base64Data) {
  const name = safeName(fileName)
  if (!base64Data || typeof base64Data !== 'string') throw new Error('文件内容无效')
  const bytes = b64Bytes(base64Data)
  if (bytes > MAX_UPLOAD_BYTES) throw new Error('文件超过 100MB，请压缩后再上传（实际约 ' + Math.round(bytes / 1048576) + 'MB）')
  const dir = 'daily-reports/uploads'
  const file = dir + '/' + period + '-' + name
  const r1 = await shellRun(ctx, '$ErrorActionPreference=' + quote('Stop') + ';New-Item -ItemType Directory -Force -Path ' + quote(dir) + '|Out-Null;[IO.File]::WriteAllBytes(' + quote(file) + ',[Convert]::FromBase64String([Console]::In.ReadToEnd()))', '.', base64Data)
  if (r1.denied) throw new Error('文件保存被沙箱策略拒绝')
  if (r1.exitCode !== 0) throw new Error('文件保存失败：' + (r1.stderr || 'exit ' + String(r1.exitCode)))
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip')) {
    const dirTarget = 'daily-reports/uploads/' + period + '-' + name.replace(/\.[^.]+$/, '') + '-unzip'
    const r2 = await shellRun(ctx, '$ErrorActionPreference=' + quote('Stop') + ';$z=' + quote(file) + ';$d=' + quote(dirTarget) + ';if(Test-Path $d){Remove-Item -LiteralPath $d -Recurse -Force};Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory($z,$d)', '.')
    if (r2.denied) throw new Error('压缩包解压被沙箱策略拒绝')
    if (r2.exitCode !== 0) throw new Error('压缩包解压失败：' + (r2.stderr || 'exit ' + String(r2.exitCode)))
    const r3 = await shellRun(ctx, 'Get-ChildItem -LiteralPath ' + quote(dirTarget) + ' -Recurse -File | Select-Object -ExpandProperty FullName', '.')
    if (r3.denied || r3.exitCode !== 0) throw new Error('压缩包内容读取失败')
    const files = r3.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 200)
    const parts = []
    let total = 0
    for (const full of files) {
      if (total >= 60000) break
      const raw = await extractTextFromTarget(ctx, full)
      const sample = raw.slice(0, 6000)
      parts.push('【文件 ' + full.replace(/\\/g, '/') + '】\n' + sample)
      total += sample.length
    }
    return { kind: 'archive', period, name, fileCount: files.length, text: parts.join('\n\n').slice(0, 120000), preview: parts.join('\n\n').slice(0, 200) }
  }
  const raw = await extractTextFromTarget(ctx, file)
  return { kind: 'document', period, name, text: raw.slice(0, 120000), preview: raw.slice(0, 200) }
}

async function createReport(ctx, data) {
  const llm = ctx.get('llm')
  const defaults = ctx.get('agentDefaultModel')
  if (llm === undefined || defaults === undefined) throw new Error('当前 Harness 未提供日报生成所需的模型服务')
  const selection = defaults.currentSelection()
  const sections = []
  if (data.morningMaterials) sections.push('【上午素材】\n' + data.morningMaterials)
  if (data.afternoonMaterials) sections.push('【下午素材】\n' + data.afternoonMaterials)
  if (data.morningFiles && data.morningFiles.trim()) sections.push('【上午文件材料】\n' + data.morningFiles)
  if (data.afternoonFiles && data.afternoonFiles.trim()) sections.push('【下午文件材料】\n' + data.afternoonFiles)
  let promptText = sections.join('\n\n')
  if (promptText.length > 60000) promptText = promptText.slice(0, 60000) + '\n……（材料过长已截断）'
  const options = {
    provider: selection.provider,
    model: selection.model,
    messages: [{ id: 'daily-report-' + String(nextSequence()), role: 'user', content: [{ type: 'text', text: promptText }], source: { kind: 'plugin', plugin: 'daily-report-assistant' } }],
    system: '你是一名严谨的中文日报编辑。上午和下午素材框可能混合包含学习文档、代码源码和会议纪要；文件材料是用户选择的文档或源代码文件夹压缩包解析出的文本。输出要求：todayCompleted 必须分点，用 "1. 2. 3. …" 逐点列出，不要加任何标题或前缀（不要写 "今日完成："），直接以 "1. " 开头，每一点对应素材中的一类内容，点与点之间用换行分隔，每点 1-3 句，涵盖当天的具体行动与成果；tomorrowPlan 同样必须分点，用 "1. 2. 3. …" 逐点列出，不要加任何标题或前缀（不要写 "明日计划："），直接以 "1. " 开头，每一点必须由 todayCompleted 的对应点拓展而来，写成可执行、可验证的计划；insights 用一段连贯的中文文字整体输出，不要分点、不要编号、不要添加任何前缀（不要写 "感悟总结："），直接以句子开头连贯叙述；insights 要扩写，写得充实而有深度，至少 5-8 句，围绕今日具体经历从多个角度展开：一是方法层面总结今天摸索出的有效工作方法或学习路径，二是认知层面提炼对技术、项目或工具的新理解，三是发现的问题与不足，四是明确的改进点和下一步如何调整，内容必须结合今日素材、文档或源码的具体细节，避免空泛套话，不得编造。严禁在 todayCompleted 和 tomorrowPlan 的分点内容里添加任何类别标签或引用前缀，例如严禁出现 "学习文档相关成果："、"代码源码相关进展："、"会议纪要相关事项："、"针对今日第 1 点："、"针对第 1 点：" 等字眼，每一点直接以 "1. " 开头后紧跟具体内容。只返回一个 JSON 对象，不要使用 Markdown 代码围栏，键必须且只能是 todayCompleted、tomorrowPlan、insights，todayCompleted 和 tomorrowPlan 为分点文本（换行分隔的 "1. 2. 3. …"），insights 为不分点的连贯中文段落。',
    maxTokens: 10000,
    temperature: 0.3,
  }
  if (selection.reasoningEffort !== undefined) options.reasoningEffort = selection.reasoningEffort
  let raw = ''
  let failure = ''
  let finishKind = ''
  const blockTexts = []
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') raw += chunk.text
    if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') blockTexts.push(chunk.block.text)
    if (chunk.type === 'finish') {
      finishKind = chunk.reason && chunk.reason.kind ? chunk.reason.kind : 'unknown'
      if (chunk.reason && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) failure = chunk.reason.failure && chunk.reason.failure.message ? chunk.reason.failure.message : chunk.reason.kind
    }
  }
  if (failure) throw new Error('模型生成失败：' + failure)
  if (!raw.trim()) {
    for (const part of blockTexts) { if (part && part.trim()) { raw = part; break } }
  }
  if (!raw.trim()) {
    if (finishKind === 'max-tokens') throw new Error('模型输出被截断（max-tokens），请减少素材量后重试')
    throw new Error('模型没有生成日报内容（模型已结束，原因：' + finishKind + '）。请重试或检查模型服务状态')
  }
  return parseReport(raw)
}

export async function createReportWithFiles(ctx, data, morningUploads, afternoonUploads) {
  const sections = []
  if (data.morningMaterials) sections.push('【上午素材】\n' + data.morningMaterials)
  if (data.afternoonMaterials) sections.push('【下午素材】\n' + data.afternoonMaterials)
  const morningText = morningUploads.map((item) => '【上午文件:' + item.name + '】\n' + item.text).join('\n\n')
  if (morningText) sections.push('【上午文件材料】\n' + morningText)
  const afternoonText = afternoonUploads.map((item) => '【下午文件:' + item.name + '】\n' + item.text).join('\n\n')
  if (afternoonText) sections.push('【下午文件材料】\n' + afternoonText)
  return createReport(ctx, { morningMaterials: sections.join('\n\n'), afternoonMaterials: '', morningFiles: '', afternoonFiles: '' })
}

export async function saveDocx(ctx, report) {
  const date = dateLabel()
  const bytes = docxBytes(report, date)
  const encoded = base64(bytes)
  const relativePath = 'daily-reports/' + date + '-日报.docx'
  const command = '$ErrorActionPreference=' + quote('Stop') + ';$d=' + quote('daily-reports') + ';New-Item -ItemType Directory -Force -Path $d|Out-Null;$p=Join-Path $d ' + quote(date + '-日报.docx') + ';$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());[IO.File]::WriteAllBytes($p,$b)'
  const result = await shellRun(ctx, command, '.', encoded)
  if (result.denied) throw new Error('文件写入被沙箱策略拒绝')
  if (result.exitCode !== 0) throw new Error('Word 文件生成失败：' + (result.stderr || 'exit ' + String(result.exitCode)))
  return { date, relativePath, workdir: '.', bytes: bytes.length, base64: encoded }
}

function extractCandidates(value) {
  const out = []
  function pushUser(u) {
    if (!u || typeof u !== 'object') return
    const userId = typeof u.userId === 'string' ? u.userId : (typeof u.id === 'string' ? u.id : '')
    const openDingTalkId = typeof u.openDingTalkId === 'string' ? u.openDingTalkId : ''
    if (!userId && !openDingTalkId) return
    out.push({ userId, openDingTalkId, name: typeof u.name === 'string' ? u.name : (typeof u.nickName === 'string' ? u.nickName : '') })
  }
  if (Array.isArray(value)) { for (const item of value) pushUser(item); return out }
  if (value && typeof value === 'object') {
    for (const key of ['result', 'items', 'users', 'list', 'data', 'contacts', 'results']) {
      const list = value[key]
      if (Array.isArray(list)) { for (const item of list) pushUser(item) }
    }
    if (out.length === 0) pushUser(value)
  }
  return out
}

export async function sendDingTalk(ctx, recipient, file) {
  const name = text(recipient, '钉钉好友')
  if (!name) throw new Error('请填写钉钉好友姓名')
  const search = await shellRun(ctx, 'dws contact user search --query ' + quote(name) + ' --format json', file.workdir)
  if (search.denied) throw new Error('钉钉联系人查询被沙箱策略拒绝')
  if (search.exitCode !== 0) throw new Error('钉钉联系人查询失败：' + (search.stderr || search.stdout || 'exit ' + String(search.exitCode)))
  let value
  try { value = JSON.parse(search.stdout) } catch (error) { throw new Error('钉钉联系人查询结果无法解析：' + search.stdout.slice(0, 300)) }
  const candidates = extractCandidates(value)
  if (candidates.length === 0) throw new Error('钉钉中找不到姓名为「' + name + '」的好友，已停止发送。请检查姓名')
  if (candidates.length > 1) throw new Error('钉钉中有 ' + String(candidates.length) + ' 个「' + name + '」，已停止发送。请使用更精确的姓名')
  const target = candidates[0]
  const targetFlag = target.userId ? '--user' : '--open-dingtalk-id'
  const targetValue = target.userId || target.openDingTalkId
  const send = await shellRun(ctx, 'dws chat message send --msg-type file --file-path ' + quote(file.relativePath) + ' ' + targetFlag + ' ' + quote(targetValue) + ' --text ' + quote('工作日报') + ' --format json --yes', file.workdir)
  if (send.denied) throw new Error('钉钉发送被沙箱策略拒绝')
  if (send.exitCode !== 0) throw new Error('钉钉发送失败：' + (send.stderr || send.stdout || 'exit ' + String(send.exitCode)))
  let delivery
  try { delivery = JSON.parse(send.stdout) } catch (error) { delivery = { raw: send.stdout.trim() } }
  return { ok: true, recipient: name, userId: targetValue, delivery }
}

export function selfTest() {
  const tests = []
  function check(name, fn) {
    try {
      fn()
      tests.push({ name, ok: true })
    } catch (error) {
      tests.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  check('accept exactly two material fields', () => {
    const v = normalizeInput({ morningMaterials: '文档和代码', afternoonMaterials: '会议纪要' })
    if (!v.morningMaterials || !v.afternoonMaterials) throw new Error('双框失败')
  })
  check('reject legacy fields', () => {
    let rejected = false
    try { normalizeInput({ morningDocs: '旧字段' }) } catch (error) { rejected = true }
    if (!rejected) throw new Error('旧字段仍可用')
  })
  check('reject empty fields', () => {
    let rejected = false
    try { normalizeInput({ morningMaterials: '', afternoonMaterials: '' }) } catch (error) { rejected = true }
    if (!rejected) throw new Error('空输入未拒绝')
  })
  check('accept uploads without text', () => {
    const v = normalizeInput({ morningMaterials: '', afternoonMaterials: '', morningUploadIds: ['upload-1'] })
    if (!v) throw new Error('有上传无文本应可接受')
    const v2 = normalizeInput({ morningMaterials: '', afternoonMaterials: '', afternoonUploadIds: ['upload-2'] })
    if (!v2) throw new Error('下午上传无文本应可接受')
    const v3 = normalizeInput({ morningMaterials: '', afternoonMaterials: '', morningUploadIds: ['upload-1'], afternoonUploadIds: ['upload-2'] })
    if (!v3) throw new Error('双上传无文本应可接受')
  })
  check('reject empty with empty upload arrays', () => {
    let rejected = false
    try { normalizeInput({ morningMaterials: '', afternoonMaterials: '', morningUploadIds: [], afternoonUploadIds: [] }) } catch (error) { rejected = true }
    if (!rejected) throw new Error('空上传数组仍应拒绝')
  })
  check('sanitize upload names', () => {
    if (safeName('a/b?c.txt') !== 'a_b_c.txt') throw new Error('名称清洗失败')
  })
  check('100MB limit counts real bytes', () => {
    if (b64Bytes('QUJD') !== 3) throw new Error('base64 字节换算错误')
    if (MAX_UPLOAD_BYTES !== 104857600) throw new Error('100MB 常量错误')
  })
  check('extract script handles docx entries', () => {
    const s = extractScript('x.docx')
    if (!s.includes('word/document.xml')) throw new Error('docx 条目缺失')
    if (!s.includes('.doc')) throw new Error('doc 提示缺失')
    if (!s.includes('"`n"')) throw new Error('换行符未用双引号')
  })
  check('extract script has no stray elseif', () => {
    const s = extractScript('x.py')
    if (!s.includes('elseif($ext')) throw new Error('elseif 缺失')
    if (s.includes(';};elseif')) throw new Error('分号断链')
    if (s.includes('+$ext+])')) throw new Error('fallback 拼接错误')
  })
  check('zip central directory parses', () => {
    const b = docxBytes({ todayCompleted: 'A', tomorrowPlan: 'B', insights: 'C' }, '2026-01-01')
    const names = zipEntries(b)
    const expected = ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml']
    if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('条目不符：' + JSON.stringify(names))
  })
  check('docx has standalone declarations', () => {
    const b = docxBytes({ todayCompleted: 'A', tomorrowPlan: 'B', insights: 'C' }, '2026-01-01')
    const dec = new TextDecoder()
    const all = dec.decode(b)
    if (!all.includes('standalone="yes"')) throw new Error('缺少 standalone=yes')
  })
  check('dingtalk candidate parse single', () => {
    const c = extractCandidates({ items: [{ userId: 'u1', name: '张三' }] })
    if (c.length !== 1 || c[0].userId !== 'u1') throw new Error('单候选解析失败')
  })
  check('dingtalk candidate parse real result field', () => {
    const c = extractCandidates({ result: [{ userId: '52390', name: '许力豪' }] })
    if (c.length !== 1 || c[0].userId !== '52390') throw new Error('result 字段解析失败')
  })
  check('dingtalk candidate parse none', () => {
    const c = extractCandidates({ result: [] })
    if (c.length !== 0) throw new Error('空候选解析失败')
  })
  check('dingtalk candidate parse multiple', () => {
    const c = extractCandidates([{ id: 'a' }, { userId: 'b' }])
    if (c.length !== 2) throw new Error('多候选解析失败')
  })
  check('parse three sections', () => parseReport('{"todayCompleted":"A","tomorrowPlan":"B","insights":"C"}'))
  check('parse fenced JSON', () => parseReport('```json\n{"todayCompleted":"A","tomorrowPlan":"B","insights":"C"}\n```'))
  check('escape OOXML', () => {
    if (xmlEscape('<A&B>') !== '&lt;A&amp;B&gt;') throw new Error('转义失败')
  })
  check('build DOCX ZIP', () => {
    const b = docxBytes({ todayCompleted: 'A', tomorrowPlan: 'B', insights: 'C' }, '2026-01-01')
    if (b.length < 2000 || b[0] !== 80 || b[1] !== 75 || b[2] !== 3 || b[3] !== 4) throw new Error('ZIP 失败')
  })
  check('three headings', () => {
    const x = documentXml({ todayCompleted: 'A', tomorrowPlan: 'B', insights: 'C' }, '2026')
    if (!x.includes('1. 今日完成工作') || !x.includes('2. 明日计划') || !x.includes('3. 感悟总结')) throw new Error('标题缺失')
  })
  check('prompt requires numbered points', () => {
    const sys = '你是一名严谨的中文日报编辑。上午和下午素材框可能混合包含学习文档、代码源码和会议纪要；文件材料是用户选择的文档或源代码文件夹压缩包解析出的文本。输出要求：todayCompleted 必须分点，用 "1. 2. 3. …" 逐点列出，不要加任何标题或前缀（不要写 "今日完成："），直接以 "1. " 开头，每一点对应素材中的一类内容，点与点之间用换行分隔，每点 1-3 句，涵盖当天的具体行动与成果；tomorrowPlan 同样必须分点，用 "1. 2. 3. …" 逐点列出，不要加任何标题或前缀（不要写 "明日计划："），直接以 "1. " 开头，每一点必须由 todayCompleted 的对应点拓展而来，写成可执行、可验证的计划；insights 用一段连贯的中文文字整体输出，不要分点、不要编号、不要添加任何前缀（不要写 "感悟总结："），直接以句子开头连贯叙述；insights 要扩写，写得充实而有深度，至少 5-8 句，围绕今日具体经历从多个角度展开：一是方法层面总结今天摸索出的有效工作方法或学习路径，二是认知层面提炼对技术、项目或工具的新理解，三是发现的问题与不足，四是明确的改进点和下一步如何调整，内容必须结合今日素材、文档或源码的具体细节，避免空泛套话，不得编造。严禁在 todayCompleted 和 tomorrowPlan 的分点内容里添加任何类别标签或引用前缀，例如严禁出现 "学习文档相关成果："、"代码源码相关进展："、"会议纪要相关事项："、"针对今日第 1 点："、"针对第 1 点：" 等字眼，每一点直接以 "1. " 开头后紧跟具体内容。只返回一个 JSON 对象，不要使用 Markdown 代码围栏，键必须且只能是 todayCompleted、tomorrowPlan、insights，todayCompleted 和 tomorrowPlan 为分点文本（换行分隔的 "1. 2. 3. …"），insights 为不分点的连贯中文段落。'
    if (!sys.includes('必须分点')) throw new Error('缺少分点要求')
    if (!sys.includes('明日计划')) throw new Error('缺少明日计划分点要求')
    if (!sys.includes('不要写 "今日完成："')) throw new Error('缺少去前缀要求')
    if (!sys.includes('严禁出现')) throw new Error('缺少禁止标签要求')
    if (!sys.includes('insights 用一段连贯的中文文字整体输出')) throw new Error('缺少 insights 不分点要求')
    if (!sys.includes('insights 要扩写')) throw new Error('缺少 insights 扩写要求')
  })
  check('mergeNumberedParagraph merges numbered lines', () => {
    const a = mergeNumberedParagraph('1. 方法层面总结\n2. 认知层面提炼\n3. 改进点')
    if (a !== '方法层面总结；认知层面提炼；改进点。') throw new Error('编号点未合并: ' + JSON.stringify(a))
    const b = mergeNumberedParagraph('这是一段已经连贯的文字，不分点。')
    if (b !== '这是一段已经连贯的文字，不分点。') throw new Error('连贯文字被误改: ' + JSON.stringify(b))
    const c = mergeNumberedParagraph('1. 只有一点')
    if (c !== '只有一点。') throw new Error('单点未合并: ' + JSON.stringify(c))
  })
  check('parseReport merges numbered insights', () => {
    const r = parseReport('{"todayCompleted":"1. A","tomorrowPlan":"1. B","insights":"感悟总结：\\n1. 方法总结\\n2. 认知提炼\\n3. 改进方向"}')
    if (r.insights !== '方法总结；认知提炼；改进方向。') throw new Error('insights 编号未合并: ' + JSON.stringify(r.insights))
  })
  check('stripSectionLabel removes labels', () => {
    const a = stripSectionLabel('今日完成：\n1. 学习文档\n2. 代码源码')
    if (a !== '1. 学习文档\n2. 代码源码') throw new Error('今日完成前缀未去掉: ' + JSON.stringify(a))
    const b = stripSectionLabel('明日计划：\n1. 继续学习')
    if (b !== '1. 继续学习') throw new Error('明日计划前缀未去掉: ' + JSON.stringify(b))
    const c = stripSectionLabel('1. 直接分点')
    if (c !== '1. 直接分点') throw new Error('无前缀内容被误删')
    const d = stripSectionLabel('【今日完成工作】\n1. A\n2. B')
    if (d !== '1. A\n2. B') throw new Error('方括号标题未去掉: ' + JSON.stringify(d))
  })
  check('stripInlineLabel removes inline labels', () => {
    const a = stripInlineLabel('1. 学习文档相关成果：研读 dsh 文档')
    if (a !== '1. 研读 dsh 文档') throw new Error('学习文档相关成果未去掉: ' + JSON.stringify(a))
    const b = stripInlineLabel('2. 代码源码相关进展：解析 sky 项目')
    if (b !== '2. 解析 sky 项目') throw new Error('代码源码相关进展未去掉: ' + JSON.stringify(b))
    const c = stripInlineLabel('3. 会议纪要相关事项：对照考核指标')
    if (c !== '3. 对照考核指标') throw new Error('会议纪要相关事项未去掉: ' + JSON.stringify(c))
    const d = stripInlineLabel('1. 针对今日第 1 点：继续深入阅读')
    if (d !== '1. 继续深入阅读') throw new Error('针对今日第 1 点未去掉: ' + JSON.stringify(d))
    const e = stripInlineLabel('2. 针对今日第 12 点：梳理业务流程')
    if (e !== '2. 梳理业务流程') throw new Error('针对今日第 12 点未去掉: ' + JSON.stringify(e))
    const f = stripInlineLabel('3. 针对第 3 点：设计评估方案')
    if (f !== '3. 设计评估方案') throw new Error('针对第 3 点未去掉: ' + JSON.stringify(f))
    const g = stripInlineLabel('1. 正常内容没有标签')
    if (g !== '1. 正常内容没有标签') throw new Error('无标签内容被误删')
  })
  check('parseReport strips labels', () => {
    const r = parseReport('{"todayCompleted":"今日完成：\\n1. 学习文档相关成果：研读文档\\n2. 代码源码相关进展：解析源码","tomorrowPlan":"明日计划：\\n1. 针对今日第 1 点：继续学习","insights":"感悟总结：\\n心得"}')
    if (r.todayCompleted !== '1. 研读文档\n2. 解析源码') throw new Error('todayCompleted 标签未去掉: ' + JSON.stringify(r.todayCompleted))
    if (r.tomorrowPlan !== '1. 继续学习') throw new Error('tomorrowPlan 标签未去掉: ' + JSON.stringify(r.tomorrowPlan))
    if (r.insights !== '心得') throw new Error('insights 前缀未去掉: ' + JSON.stringify(r.insights))
  })
  check('para keeps numbered lines', () => {
    const x = para('1. 学习文档\n2. 代码源码\n3. 会议纪要')
    if (!x.includes('1. 学习文档') || !x.includes('2. 代码源码') || !x.includes('3. 会议纪要')) throw new Error('分点行未保留')
    if (x.indexOf('1. 学习文档') > x.indexOf('2. 代码源码')) throw new Error('分点顺序错误')
  })
  return { ok: tests.every((item) => item.ok), fieldCount: 2, fields: ['morningMaterials', 'afternoonMaterials'], tests }
}

function zipEntries(bytes) {
  const names = []
  const n = bytes.length
  if (n < 22) throw new Error('文件过短')
  if (bytes[n - 22] !== 80 || bytes[n - 21] !== 75 || bytes[n - 20] !== 5 || bytes[n - 19] !== 6) throw new Error('缺少 EOCD 签名')
  const cdOffset = bytes[n - 6] | (bytes[n - 5] << 8) | (bytes[n - 4] << 16) | (bytes[n - 3] << 24)
  const cdLen = bytes[n - 10] | (bytes[n - 9] << 8) | (bytes[n - 8] << 16) | (bytes[n - 7] << 24)
  if (cdOffset + cdLen > n - 22) throw new Error('中央目录越界')
  let pos = cdOffset
  const end = cdOffset + cdLen
  while (pos < end) {
    if (pos + 46 > n) throw new Error('中央目录头越界')
    if (bytes[pos] !== 80 || bytes[pos + 1] !== 75 || bytes[pos + 2] !== 1 || bytes[pos + 3] !== 2) throw new Error('中央目录签名错误 @' + pos)
    const nameLen = bytes[pos + 28] | (bytes[pos + 29] << 8)
    const extraLen = bytes[pos + 30] | (bytes[pos + 31] << 8)
    const commentLen = bytes[pos + 32] | (bytes[pos + 33] << 8)
    if (pos + 46 + nameLen > n) throw new Error('条目名越界')
    const dec = new TextDecoder()
    names.push(dec.decode(bytes.slice(pos + 46, pos + 46 + nameLen)))
    pos += 46 + nameLen + extraLen + commentLen
  }
  return names
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function makeRoutes(ctx) {
  return [
    {
      path: API_PREFIX + '/health',
      handler: (req, res) => {
        writeJson(res, 200, {
          ok: ctx.get('llm') !== undefined && ctx.get('agentDefaultModel') !== undefined && ctx.get('shell') !== undefined,
          fieldCount: 2,
          uploadReady: true,
        })
      },
    },
    {
      path: API_PREFIX + '/self-test',
      handler: (req, res) => {
        writeJson(res, 200, selfTest())
      },
    },
    {
      path: API_PREFIX + '/upload-file',
      handler: async (req, res) => {
        try {
          const args = await readJsonBody(req, MAX_UPLOAD_BYTES * 2)
          if (!args || typeof args !== 'object') throw new Error('上传参数无效')
          const period = args.period === 'afternoon' ? 'afternoon' : 'morning'
          const result = await ingestUpload(ctx, period, args.name, args.base64)
          const id = 'upload-' + String(nextSequence())
          uploads.set(id, { period, item: result })
          if (uploads.size > 24) uploads.delete(uploads.keys().next().value)
          writeJson(res, 200, { ok: true, id, period, name: result.name, kind: result.kind, fileCount: result.kind === 'archive' ? result.fileCount : 1, chars: result.text.length, preview: result.preview || '' })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: API_PREFIX + '/generate-report',
      handler: async (req, res) => {
        try {
          const args = await readJsonBody(req, 2 * 1024 * 1024)
          const data = normalizeInput(args)
          const morning = []
          const afternoon = []
          if (args && typeof args === 'object' && Array.isArray(args.morningUploadIds)) {
            for (const id of args.morningUploadIds) {
              const record = uploads.get(String(id))
              if (record && record.period === 'morning') morning.push(record.item)
            }
          }
          if (args && typeof args === 'object' && Array.isArray(args.afternoonUploadIds)) {
            for (const id of args.afternoonUploadIds) {
              const record = uploads.get(String(id))
              if (record && record.period === 'afternoon') afternoon.push(record.item)
            }
          }
          const report = await createReportWithFiles(ctx, data, morning, afternoon)
          const file = await saveDocx(ctx, report)
          const id = 'report-' + String(nextSequence())
          outputs.set(id, { report, file })
          writeJson(res, 200, { ok: true, id, report, file: { date: file.date, relativePath: file.relativePath, bytes: file.bytes, downloadBase64: file.base64 } })
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      path: API_PREFIX + '/send-report',
      handler: async (req, res) => {
        try {
          const args = await readJsonBody(req, 64 * 1024)
          if (!args || typeof args !== 'object') throw new Error('发送参数无效')
          const item = outputs.get(text(args.id, '日报编号'))
          if (!item) throw new Error('找不到该日报，请重新生成')
          const result = await sendDingTalk(ctx, args.recipient, item.file)
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}
