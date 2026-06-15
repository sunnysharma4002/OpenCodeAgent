import * as vscode from 'vscode';
import { OpenCodeClient } from './openCodeClient';
import { SidePanelProvider } from './sidePanel';

export function activate(context: vscode.ExtensionContext) {
  const apiKey = vscode.workspace.getConfiguration('opencodeAgent').get<string>('apiKey') || '';
  const baseUrl = 'https://opencode.ai/zen/v1';

  const client = new OpenCodeClient(baseUrl, apiKey);
  const provider = new SidePanelProvider(context.extensionUri, client, context);

  const registration = vscode.window.registerWebviewViewProvider('opencodeAgent.sidePanel', provider, {
    webviewOptions: { retainContextWhenHidden: true }
  });

  context.subscriptions.push(registration);
}

export function deactivate() {}
