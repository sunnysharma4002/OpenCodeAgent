import * as vscode from 'vscode';
import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file relative to the workspace root.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace root' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (overwrites existing). Creates parent directories if needed.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace root' }, content: { type: 'string', description: 'File content' } }, required: ['path', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in a folder relative to workspace root.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory path relative to workspace root' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the workspace directory. Returns stdout + stderr.',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for a regex pattern in workspace files. Returns matching file:line matches.',
      parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern' }, include: { type: 'string', description: 'File glob filter (e.g. *.ts, *.{ts,js})' } }, required: ['pattern'] }
    }
  }
];

function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
}

function resolvePath(p: string): string {
  const root = getWorkspaceRoot();
  const full = path.resolve(root, p);
  if (!full.startsWith(root)) throw new Error('Path escapes workspace');
  return full;
}

function executeTool(tool: ToolCall): string {
  const args = JSON.parse(tool.function.arguments);
  const root = getWorkspaceRoot();

  switch (tool.function.name) {
    case 'read_file': {
      const filePath = resolvePath(args.path);
      return fs.readFileSync(filePath, 'utf-8');
    }
    case 'write_file': {
      const filePath = resolvePath(args.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content, 'utf-8');
      return `Written ${args.path}`;
    }
    case 'list_files': {
      const dirPath = resolvePath(args.path);
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      return entries.map(e => (e.isDirectory() ? e.name + '/' : e.name)).join('\n');
    }
    case 'run_command': {
      const cwd = root;
      try {
        const stdout = execSync(args.command, { cwd, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        return stdout.trim() || '(empty output)';
      } catch (e: any) {
        return `Exit code ${e.status}:\n${e.stdout || ''}\n${e.stderr || ''}`.trim();
      }
    }
    case 'grep_search': {
      const include = args.include || '**/*';
      // Use ripgrep-style search via findstr on Windows
      try {
        return execSync(`findstr /S /N /C:"${args.pattern.replace(/"/g, '\\"')}" ${include.includes('*') ? include : '*'}`, {
          cwd: root, timeout: 15000, encoding: 'utf-8', maxBuffer: 1024 * 1024
        }).trim() || '(no matches)';
      } catch {
        return '(no matches or error)';
      }
    }
    default:
      return `Unknown tool: ${tool.function.name}`;
  }
}

export class OpenCodeClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  private async chatCompletion(body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Zen API error (${response.status}): ${text}`);
    }
    return response.json();
  }

  async ask(model: string, messages: ChatMessage[]): Promise<ChatMessage> {
    const apiMessages = messages.map(m => {
      const msg: any = { role: m.role };
      if (m.content) {
        msg.content = m.content;
      } else if (m.role === 'tool') {
        msg.content = m.content || '';
      } else {
        msg.content = m.content || '';
      }
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.name) msg.name = m.name;
      return msg;
    });

    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      tools: TOOLS,
      stream: false
    };

    const data = await this.chatCompletion(body);
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No response from model');

    const msg = choice.message;
    const result: ChatMessage = { role: 'assistant', content: msg.content || '' };
    if (msg.tool_calls) {
      result.tool_calls = msg.tool_calls;
    }
    return result;
  }

  async agentLoop(model: string, messages: ChatMessage[], onToolCall?: (name: string, args: string, result?: string) => void): Promise<string> {
    let finalContent = '';

    while (true) {
      const response = await this.ask(model, messages);

      if (response.tool_calls && response.tool_calls.length > 0) {
        messages.push(response);
        for (const tc of response.tool_calls) {
          const name = tc.function.name;
          if (onToolCall) onToolCall(name, tc.function.arguments);
          let result: string;
          try {
            result = executeTool(tc);
            if (result.length > 50000) result = result.slice(0, 50000) + '\n... (truncated)';
          } catch (e: any) {
            result = `Error: ${e.message}`;
          }
          if (onToolCall) onToolCall(name, tc.function.arguments, result);
          messages.push({
            role: 'tool',
            content: result,
            tool_call_id: tc.id,
            name
          });
        }
      } else {
        finalContent = response.content || '';
        messages.push(response);
        break;
      }
    }

    return finalContent;
  }
}

export function getChatHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; font-src 'self';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
  --msg-gap: 4px;
  --radius: 6px;
  --radius-lg: 10px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--vscode-sideBar-background, #1e1e1e);
  color: var(--vscode-foreground, #cccccc);
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
  height: 100vh; display: flex; flex-direction: column; font-size: 13px; line-height: 1.5;
}

/* ── header ── */
header {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); flex-shrink: 0;
}
#newSession {
  border: 0; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 11px; font-weight: 500;
  padding: 4px 10px; background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ccc); transition: opacity .15s; white-space: nowrap;
}
#newSession:hover { opacity: .8; }
#statusWrap { display: flex; align-items: center; gap: 6px; margin-left: auto; }
#statusDot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: #555; transition: background .3s; }
#statusDot.connected { background: #4ec94e; box-shadow: 0 0 4px rgba(78,201,78,.4); }
#statusDot.error { background: #e74c3c; }
#statusDot.busy { background: #f0ad4e; animation: pulse 1s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
#statusText { color: var(--vscode-descriptionForeground, #888); font-size: 11px; }

/* ── messages area ── */
#messages { flex: 1; overflow-y: auto; padding: 12px 12px 8px; display: flex; flex-direction: column; gap: var(--msg-gap); }
.message {
  padding: 10px 12px; line-height: 1.6; animation: msgIn .2s ease;
  max-width: 100%; word-wrap: break-word;
}
@keyframes msgIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

/* user message */
.message.user {
  align-self: flex-end; max-width: 88%; border-radius: var(--radius-lg) var(--radius-lg) 4px var(--radius-lg);
  background: var(--vscode-textBlockQuote-background, #2a2d2e);
  border: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 10px 14px;
}

/* assistant message */
.message.assistant {
  align-self: stretch; border-radius: var(--radius-lg) var(--radius-lg) var(--radius-lg) 4px;
  padding: 2px 0; background: transparent; border: 0;
}
.message.assistant .content { padding: 8px 4px; }
.message.assistant .content p { margin: 6px 0; min-height: 1em; }
.message.assistant .content p:first-child { margin-top: 0; }
.message.assistant .content p:last-child { margin-bottom: 0; }
.message.assistant .content code {
  font-family: var(--vscode-editor-font-family, Consolas, monospace); font-size: 12px;
  background: var(--vscode-textCodeBlock-background, #2a2d2e); padding: 1px 5px; border-radius: 3px;
}
.message.assistant .content pre {
  margin: 8px 0; border-radius: 6px; overflow: hidden;
  background: var(--vscode-textCodeBlock-background, #1e1e1e);
  border: 1px solid var(--vscode-panel-border, #3c3c3c);
}
.message.assistant .content pre .codeHeader {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground, #888);
  background: rgba(127,127,127,.06); border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
}
.message.assistant .content pre .codeHeader button {
  background: transparent; border: 0; color: var(--vscode-descriptionForeground, #888);
  cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 3px; font-family: inherit;
}
.message.assistant .content pre .codeHeader button:hover { background: rgba(127,127,127,.15); color: var(--vscode-foreground, #ccc); }
.message.assistant .content pre code {
  display: block; padding: 12px 16px; overflow-x: auto; font-size: 12px; line-height: 1.5; background: transparent; border-radius: 0;
}
.message.assistant .content ul, .message.assistant .content ol { padding-left: 20px; margin: 6px 0; }
.message.assistant .content li { margin: 3px 0; }
.message.assistant .content strong { font-weight: 600; }
.message.assistant .content a { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
.message.assistant .content a:hover { text-decoration: underline; }
.message.assistant .content h1, .message.assistant .content h2, .message.assistant .content h3 { margin: 10px 0 4px; font-weight: 600; }
.message.assistant .content h1 { font-size: 16px; } .message.assistant .content h2 { font-size: 14px; } .message.assistant .content h3 { font-size: 13px; }
.message.assistant .content blockquote {
  margin: 6px 0; padding: 4px 12px; border-left: 3px solid var(--vscode-panel-border, #3c3c3c);
  color: var(--vscode-descriptionForeground, #888);
}
.message.assistant .content table { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.message.assistant .content th, .message.assistant .content td { border: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 4px 10px; text-align: left; }
.message.assistant .content th { font-weight: 600; background: rgba(127,127,127,.06); }

/* tool call message */
.message.tool_call {
  align-self: stretch; font-size: 11px; color: var(--vscode-descriptionForeground, #888);
  background: rgba(127,127,127,.04); border: 1px solid rgba(127,127,127,.12); border-radius: 6px;
  padding: 6px 14px;
}
.message.tool_call .toolName { font-weight: 500; }
.message.tool_call .toolArgs { font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; opacity: .6; margin-top: 2px; }

/* tool result (edit) message */
.message.tool_result {
  align-self: stretch; font-size: 11px; border-radius: 6px; overflow: hidden;
  border: 1px solid rgba(76,175,80,.25); margin: 2px 0;
}
.message.tool_result .resultHeader {
  display: flex; align-items: center; gap: 6px; padding: 5px 12px;
  background: rgba(76,175,80,.08); border-bottom: 1px solid rgba(76,175,80,.15);
  color: #81c784; font-weight: 500;
}
.message.tool_result .resultHeader .icon { font-size: 13px; }
.message.tool_result .resultFile {
  padding: 6px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  color: var(--vscode-foreground, #ccc); background: rgba(127,127,127,.03);
  border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); word-break: break-all;
}
.message.tool_result .resultBody {
  padding: 8px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  color: var(--vscode-foreground, #ccc); max-height: 300px; overflow-y: auto;
}
.message.tool_result .resultDiff {
  padding: 0; margin: 0; overflow-x: auto;
}
.message.tool_result .resultDiff .diffLine {
  padding: 1px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  line-height: 1.5; white-space: pre; tab-size: 2;
}
.message.tool_result .resultDiff .diffAdd { background: rgba(76,175,80,.12); color: #a5d6a7; }
.message.tool_result .resultDiff .diffRemove { background: rgba(244,67,54,.12); color: #ef9a9a; }

/* ── thinking indicator ── */
#thinking {
  display: none; align-items: center; gap: 8px; padding: 8px 16px 4px;
  font-size: 12px; color: var(--vscode-descriptionForeground, #888);
}
#thinking.show { display: flex; }
#thinking .dots { display: flex; gap: 3px; }
#thinking .dots span {
  width: 5px; height: 5px; border-radius: 50%; background: currentColor;
  animation: dotBounce 1.4s infinite; opacity: .4;
}
#thinking .dots span:nth-child(2) { animation-delay: .2s; }
#thinking .dots span:nth-child(3) { animation-delay: .4s; }
@keyframes dotBounce { 0%, 80%, 100% { transform: scale(.7); opacity: .3; } 40% { transform: scale(1); opacity: .8; } }

/* ── input area ── */
#inputArea {
  display: flex; gap: 6px; padding: 10px 12px 12px;
  border-top: 1px solid var(--vscode-panel-border, #3c3c3c); flex-shrink: 0;
}
#prompt {
  flex: 1; min-height: 38px; max-height: 140px; resize: none;
  border: 1px solid var(--vscode-input-border, #555); border-radius: var(--radius);
  background: var(--vscode-input-background, #252526); color: var(--vscode-input-foreground, #ccc);
  padding: 8px 12px; font-family: inherit; font-size: 13px; line-height: 1.5;
  outline: none; transition: border-color .15s;
}
#prompt:focus { border-color: var(--vscode-focusBorder, #007acc); }
#prompt::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
#send {
  border: 0; border-radius: var(--radius); cursor: pointer; font-family: inherit; font-size: 13px;
  padding: 0 16px; background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff); transition: opacity .15s; white-space: nowrap;
}
#send:hover { opacity: .85; } #send:disabled { opacity: .3; cursor: default; }

/* ── bottom bar (model selector) ── */
#bottomBar {
  display: flex; align-items: center; padding: 4px 12px 8px; flex-shrink: 0;
  border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
}
#bottomBar #modelWrap { position: relative; }
#bottomBar #modelBtn {
  background: transparent; color: var(--vscode-descriptionForeground, #888);
  border: 1px solid transparent; border-radius: 4px;
  padding: 3px 20px 3px 8px; cursor: pointer; font-family: inherit; font-size: 11px;
  white-space: nowrap; max-width: 200px; overflow: hidden; text-overflow: ellipsis; position: relative; transition: border-color .15s;
}
#bottomBar #modelBtn:hover { border-color: var(--vscode-dropdown-border, #555); color: var(--vscode-foreground, #ccc); }
#bottomBar #modelBtn::after { content: '\\25BE'; position: absolute; right: 6px; top: 50%; transform: translateY(-50%); font-size: 9px; }
#bottomBar #modelList {
  display: none; position: absolute; bottom: 100%; left: 0; z-index: 20; min-width: 240px;
  background: var(--vscode-dropdown-background, #313131); border: 1px solid var(--vscode-dropdown-border, #555);
  border-radius: 6px; margin-bottom: 4px; padding: 4px; box-shadow: 0 -4px 16px rgba(0,0,0,.4);
}
#bottomBar #modelList.open { display: block; }
#bottomBar .modelItem {
  padding: 6px 10px; cursor: pointer; font-size: 12px; border-radius: 4px; transition: background .1s;
}
#bottomBar .modelItem:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
#bottomBar .modelItem.active { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }

/* ── empty state ── */
#emptyState {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 32px; text-align: center;
}
#emptyState .icon { font-size: 36px; opacity: .15; line-height: 1; }
#emptyState p { font-size: 12px; max-width: 240px; line-height: 1.6; color: var(--vscode-descriptionForeground, #999); }
#emptyState .hint { font-size: 11px; color: var(--vscode-descriptionForeground, #777); max-width: 260px; line-height: 1.5; }
.hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <button id="newSession" title="Start a new conversation">+ New</button>
  <div id="statusWrap"><span id="statusDot"></span><span id="statusText">Ready</span></div>
</header>
<main id="messages"></main>
<div id="thinking"><span>Thinking</span><span class="dots"><span></span><span></span><span></span></span></div>
<div id="emptyState">
  <div class="icon">&#9670;</div>
  <p>Ask the OpenCode agent to inspect, edit, or write code in your workspace.</p>
  <div class="hint">e.g. "read package.json", "add error handling to main.ts", "run tests"</div>
</div>
<div id="inputArea">
  <textarea id="prompt" placeholder="Ask the agent..." rows="1"></textarea>
  <button id="send" type="button">Send</button>
</div>
<div id="bottomBar">
  <div id="modelWrap">
    <button id="modelBtn">Loading...</button>
    <div id="modelList"></div>
  </div>
</div>
<script>
(function(){
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const messages = $('messages'), prompt = $('prompt'), send = $('send');
const statusText = $('statusText'), statusDot = $('statusDot');
const emptyState = $('emptyState'), modelBtn = $('modelBtn'), modelList = $('modelList');
const thinking = $('thinking');
let selectedModel = '';

function setStatus(text, state) { statusText.textContent = text; statusDot.className = state || ''; }
function setBusy(busy) {
  send.disabled = busy; prompt.disabled = busy;
  thinking.classList.toggle('show', busy);
}

// ── model dropdown ──
modelBtn.addEventListener('click', e => { e.stopPropagation(); modelList.classList.toggle('open'); });
document.addEventListener('click', () => modelList.classList.remove('open'));

function setModelOptions(models) {
  modelList.innerHTML = '';
  models.forEach(m => {
    const item = document.createElement('div'); item.className = 'modelItem'; item.dataset.model = m;
    item.textContent = m;
    item.addEventListener('click', () => {
      selectedModel = m; modelBtn.textContent = m;
      modelList.querySelectorAll('.modelItem').forEach(el => el.classList.remove('active'));
      item.classList.add('active'); modelList.classList.remove('open');
      vscode.postMessage({ type: 'setModel', body: { model: m } });
    });
    modelList.appendChild(item);
  });
  if (models.length) { selectedModel = models[0]; modelBtn.textContent = models[0]; modelList.querySelector('.modelItem')?.classList.add('active'); }
}

// ── markdown render ──
const BT = '\x60\x60\x60';
const BT_S = '\x60';
function renderMarkdown(text) {
  let html = '';
  let i = 0;
  while (i < text.length) {
    const codeStart = text.indexOf(BT, i);
    if (codeStart !== -1 && (codeStart === i || text[codeStart-1] !== '\\\\')) {
      html += escapeHtml(text.slice(i, codeStart));
      const close = text.indexOf(BT, codeStart + 3);
      if (close === -1) { html += escapeHtml(text.slice(codeStart)); break; }
      const firstLine = text.indexOf('\\n', codeStart + 3);
      const lang = firstLine !== -1 && firstLine < close ? text.slice(codeStart + 3, firstLine).trim() : '';
      const code = firstLine !== -1 ? text.slice(firstLine + 1, close) : text.slice(codeStart + 3, close);
      html += '<pre><div class="codeHeader"><span>' + (lang || 'code') + '</span><button onclick="(function(btn){var c=btn.parentElement.nextElementSibling.textContent;navigator.clipboard.writeText(c);btn.textContent=\\'Copied\\';setTimeout(function(){btn.textContent=\\'Copy\\'},2000)})(this)">Copy</button></div><code>' + escapeHtml(code.trim()) + '</code></pre>';
      i = close + 3;
      continue;
    }
    const inlineStart = text.indexOf(BT_S, i);
    if (inlineStart !== -1 && (inlineStart === i || text[inlineStart-1] !== '\\\\')) {
      html += escapeHtml(text.slice(i, inlineStart));
      const inlineEnd = text.indexOf(BT_S, inlineStart + 1);
      if (inlineEnd === -1) { html += escapeHtml(text.slice(inlineStart)); break; }
      html += '<code>' + escapeHtml(text.slice(inlineStart + 1, inlineEnd)) + '</code>';
      i = inlineEnd + 1;
      continue;
    }
    html += escapeHtml(text.slice(i));
    break;
  }
  const lines = html.split('\\n');
  let result = ''; let inList = false; let inBlock = false;
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (l.indexOf('<pre>') !== -1) { if (inList) { result += '</ul>'; inList = false; } result += l + '\\n'; inBlock = true; continue; }
    if (l.indexOf('</pre>') !== -1) { if (inList) { result += '</ul>'; inList = false; } result += l + '\\n'; inBlock = false; continue; }
    if (inBlock) { result += l + '\\n'; continue; }
    if (l.trim() === '') { if (inList) { result += '</ul>'; inList = false; } continue; }
    if (/^(&\\d+;|[-*])\\s/.test(l)) {
      if (!inList) { result += '<ul>'; inList = true; }
      result += '<li>' + l.replace(/^(&\\d+;|[-*])\\s/, '') + '</li>\\n';
      continue;
    }
    if (inList) { result += '</ul>'; inList = false; }
    if (/^#{1,3}\\s/.test(l)) {
      const level = l.match(/^#+/)[0].length;
      result += '<h' + level + '>' + l.replace(/^#+\\s/, '') + '</h' + level + '>\\n';
      continue;
    }
    result += '<p>' + l.trim() + '</p>\\n';
  }
  if (inList) result += '</ul>';
  return result;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function appendMessage(role, text) {
  emptyState.classList.add('hidden');
  const wrapper = document.createElement('section'); wrapper.className = 'message ' + role;

  if (role === 'user') {
    const c = document.createElement('div'); c.textContent = text; wrapper.appendChild(c);
  } else if (role === 'assistant') {
    const c = document.createElement('div'); c.className = 'content'; c.innerHTML = renderMarkdown(text);
    wrapper.appendChild(c);
  } else {
    const c = document.createElement('div'); c.textContent = text; wrapper.appendChild(c);
  }
  messages.appendChild(wrapper);
  await nextFrame();
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

async function appendToolCall(name, args) {
  emptyState.classList.add('hidden');
  const wrapper = document.createElement('section'); wrapper.className = 'message tool_call';
  const nameEl = document.createElement('span'); nameEl.className = 'toolName'; nameEl.textContent = '\\u26A1 ' + name;
  const argsEl = document.createElement('div'); argsEl.className = 'toolArgs'; argsEl.textContent = args;
  wrapper.appendChild(nameEl); wrapper.appendChild(argsEl);
  messages.appendChild(wrapper);
  await nextFrame();
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function formatToolResult(name, args, toolResult) {
  let path = '';
  let content = '';
  try {
    const parsed = JSON.parse(args);
    path = parsed.path || '';
    content = parsed.content || '';
  } catch (e) {}
  let html = '<div class="resultHeader"><span class="icon">\\u2714</span>' + escapeHtml(name) + '</div>';
  if (path) html += '<div class="resultFile">' + escapeHtml(path) + '</div>';
  if (name === 'write_file' && content) {
    const lines = content.split('\\n');
    let diffHtml = '<div class="resultDiff">';
    lines.forEach(l => {
      diffHtml += '<div class="diffLine diffAdd">+ ' + escapeHtml(l) + '</div>';
    });
    diffHtml += '</div>';
    html += diffHtml;
  } else if (toolResult) {
    html += '<div class="resultBody">' + escapeHtml(toolResult) + '</div>';
  }
  return html;
}

async function appendToolResult(name, args, toolResult) {
  emptyState.classList.add('hidden');
  const wrapper = document.createElement('section'); wrapper.className = 'message tool_result';
  wrapper.innerHTML = formatToolResult(name, args, toolResult);
  messages.appendChild(wrapper);
  await nextFrame();
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function nextFrame() { return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }

// ── input ──
document.getElementById('newSession').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
send.addEventListener('click', submit);
prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
prompt.addEventListener('input', () => { prompt.style.height = 'auto'; prompt.style.height = Math.min(prompt.scrollHeight, 140) + 'px'; });

function submit() {
  const text = prompt.value.trim();
  if (!text || send.disabled) return;
  prompt.value = ''; prompt.style.height = 'auto'; setBusy(true);
  vscode.postMessage({ type: 'ask', body: { text, model: selectedModel } });
}

// ── message handler ──
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'appendMessage': appendMessage(msg.body.role, msg.body.text); break;
    case 'appendToolCall': appendToolCall(msg.body.name, msg.body.args); break;
    case 'appendToolResult': appendToolResult(msg.body.name, msg.body.args, msg.body.toolResult); break;
    case 'restoreMessages': emptyState.classList.add('hidden'); msg.body.messages.forEach(m => appendMessage(m.role, m.text)); break;
    case 'resetMessages': messages.innerHTML = ''; emptyState.classList.remove('hidden'); break;
    case 'setStatus': setStatus(msg.body.text, msg.body.state); break;
    case 'setBusy': setBusy(msg.body); break;
    case 'setModelOptions': setModelOptions(msg.body.models); break;
    case 'setModel': selectedModel = msg.body.model; modelBtn.textContent = msg.body.model; break;
  }
});

vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
