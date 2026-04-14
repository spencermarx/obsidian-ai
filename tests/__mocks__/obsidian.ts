/**
 * Minimal Obsidian API stubs for unit testing.
 *
 * Only the symbols actually imported by non-view source files are
 * stubbed here. View-layer tests (if ever added) would need a more
 * complete mock or a DOM environment.
 */

export class ItemView {
  app: unknown = {};
  containerEl = { children: [null, { empty: () => {}, addClass: () => {} }] };
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
}

export class PluginSettingTab {
  app: unknown;
  containerEl = { empty: () => {}, createEl: () => ({}) };
  constructor(app: unknown) {
    this.app = app;
  }
  display(): void {}
}

export class MarkdownView {
  editor = { getSelection: () => "", getCursor: () => ({ line: 0, ch: 0 }) };
  file = { path: "" };
}

export class Notice {
  constructor(_message: string) {}
}

export class Setting {
  constructor(_el: unknown) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addText() {
    return this;
  }
  addDropdown() {
    return this;
  }
  addToggle() {
    return this;
  }
}

export class MarkdownRenderer {
  static render(): Promise<void> {
    return Promise.resolve();
  }
}

export function setIcon(_el: unknown, _icon: string): void {}

export class Plugin {
  app: unknown = {};
  loadData(): Promise<unknown> {
    return Promise.resolve(null);
  }
  saveData(): Promise<void> {
    return Promise.resolve();
  }
  addCommand(): void {}
  addRibbonIcon(): unknown {
    return {};
  }
  registerView(): void {}
  addSettingTab(): void {}
}

export class FuzzySuggestModal {
  constructor(_app: unknown) {}
}

export const Platform = { isDesktop: true };
