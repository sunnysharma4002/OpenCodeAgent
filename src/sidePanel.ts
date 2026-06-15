import * as vscode from 'vscode';
import { OpenCodeClient, ChatMessage } from './openCodeClient';
import { getChatHtml } from './openCodeClient';

const HISTORY_KEY = 'opencodeConversation';

const MODELS = [
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
  'big-pickle'
];

export class SidePanelProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private selectedModel: string = MODELS[0];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: OpenCodeClient,
    private readonly context: vscode.ExtensionContext
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getChatHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          await this.onReady();
          break;
        case 'ask':
          await this.onAsk(msg.body.text, msg.body.model || this.selectedModel);
          break;
        case 'newSession':
          await this.onNewSession();
          break;
        case 'setModel':
          this.selectedModel = msg.body.model;
          this.context.workspaceState.update('selectedModel', msg.body.model);
          break;
      }
    });

    webviewView.onDidDispose(() => this.saveHistory());
  }

  private async onReady() {
    this.post({ type: 'setModelOptions', body: { models: MODELS } });

    const saved = this.context.globalState.get<ChatMessage[]>(HISTORY_KEY, []);
    if (saved.length > 0) {
      this.messages = saved;
      this.post({ type: 'restoreMessages', body: { messages: saved } });
    }
    this.post({ type: 'setStatus', body: { text: 'Ready', state: 'connected' } });
  }

  private async onAsk(text: string, model?: string) {
    this.messages.push({ role: 'user', content: text });
    this.post({ type: 'appendMessage', body: { role: 'user', text } });
    this.saveHistory();

    const currentModel = model || this.selectedModel;

    try {
      this.post({ type: 'setStatus', body: { text: 'Agent thinking...', state: 'busy' } });

      const result = await this.client.agentLoop(
        currentModel,
        this.messages,
        (name, args, toolResult) => {
          if (toolResult === undefined) {
            this.post({ type: 'appendToolCall', body: { name, args } });
            this.post({ type: 'setStatus', body: { text: `Running: ${name}...`, state: 'busy' } });
          } else {
            this.post({ type: 'appendToolResult', body: { name, args, toolResult } });
          }
        }
      );

      if (result) {
        this.post({ type: 'appendMessage', body: { role: 'assistant', text: result } });
      }
      this.saveHistory();
      this.post({ type: 'setStatus', body: { text: 'Ready', state: 'connected' } });
    } catch (e: any) {
      const msg = e.message || String(e);
      this.post({ type: 'appendMessage', body: { role: 'assistant', text: `Error: ${msg}` } });
      this.post({ type: 'setStatus', body: { text: 'Error', state: 'error' } });
    } finally {
      this.post({ type: 'setBusy', body: false });
    }
  }

  private async onNewSession() {
    this.messages = [];
    this.post({ type: 'resetMessages' });
    this.saveHistory();
  }

  private saveHistory() {
    this.context.globalState.update(HISTORY_KEY, this.messages);
  }

  private post(msg: any) {
    this._view?.webview.postMessage(msg);
  }
}
