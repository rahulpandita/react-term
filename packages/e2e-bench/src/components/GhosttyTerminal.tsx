import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TerminalApi } from "../types.js";

interface Props {
  cols: number;
  rows: number;
}

interface GhosttyModule {
  init(): Promise<void>;
  Terminal: new (opts: {
    cols: number;
    rows: number;
  }) => {
    open(el: HTMLElement): void;
    write(data: string | Uint8Array): void;
    resize(cols: number, rows: number): void;
    dispose(): void;
  };
}

let ghosttyModule: GhosttyModule | null = null;
let ghosttyLoadFailed = false;

async function loadGhostty(): Promise<GhosttyModule | null> {
  if (ghosttyModule) return ghosttyModule;
  if (ghosttyLoadFailed) return null;
  try {
    // Use variable to prevent Vite from statically analyzing this import
    const pkg = "ghostty-web";
    const mod = (await import(/* @vite-ignore */ pkg)) as unknown as GhosttyModule;
    await mod.init();
    ghosttyModule = mod;
    return mod;
  } catch {
    ghosttyLoadFailed = true;
    return null;
  }
}

export const GhosttyTerminal = forwardRef<TerminalApi, Props>(function GhosttyTerminal(
  { cols, rows },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<InstanceType<GhosttyModule["Terminal"]> | null>(null);
  const initialized = useRef(false);
  const [error, setError] = useState<string | null>(null);

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

    let terminal: InstanceType<GhosttyModule["Terminal"]> | null = null;

    loadGhostty().then((mod) => {
      if (!mod) {
        setError("ghostty-web not available");
        return;
      }
      terminal = new mod.Terminal({ cols, rows });
      terminal.open(container);
      termRef.current = terminal;
    });

    return () => {
      terminal?.dispose();
      termRef.current = null;
      initialized.current = false;
    };
  }, [cols, rows]);

  if (error) {
    return (
      <div style={{ padding: 20, color: "#ff6b6b" }}>{error} — install ghostty-web to enable</div>
    );
  }

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
});
