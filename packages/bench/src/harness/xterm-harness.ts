import { Terminal } from "@xterm/headless";

export interface XtermHarness {
  write(data: Uint8Array): Promise<void>;
  dispose(): void;
}

export function createXtermHarness(cols = 80, rows = 24): XtermHarness {
  const terminal = new Terminal({
    cols,
    rows,
    scrollback: 0,
    allowProposedApi: true,
  });

  return {
    write(data: Uint8Array): Promise<void> {
      return new Promise<void>((resolve) => {
        terminal.write(data, resolve);
      });
    },
    dispose() {
      terminal.dispose();
    },
  };
}
