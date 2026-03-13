import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalApi } from "../types.js";

interface Props {
  cols: number;
  rows: number;
}

export const XtermTerminal = forwardRef<TerminalApi, Props>(function XtermTerminal(
  { cols, rows },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const initialized = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      write(data: string | Uint8Array) {
        termRef.current?.write(data);
      },
      resize(c: number, r: number) {
        termRef.current?.resize(c, r);
      },
    }),
    [],
  );

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({ cols, rows });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();

    termRef.current = terminal;
    fitRef.current = fit;

    return () => {
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
      initialized.current = false;
    };
  }, [cols, rows]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
});
