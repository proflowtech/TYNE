import type * as vscode from 'vscode';

let extensionContext: vscode.ExtensionContext | undefined;

export function initializeTaskProviderRuntime(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

export function getTaskProviderRuntimeContext(): vscode.ExtensionContext | undefined {
  return extensionContext;
}

export function hasTaskProviderRuntimeContext(): boolean {
  return Boolean(extensionContext);
}
