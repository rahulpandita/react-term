import { fillAligned, type Scenario } from "./types.js";

const SIZE = 5 * 1024 * 1024;

/** Simulated `ls -lR` with ANSI colors — mixed realistic workload. */
export function realWorld(): Scenario {
  const encoder = new TextEncoder();
  const lines = [
    "\x1b[0m\x1b[01;34mdrwxr-xr-x\x1b[0m  5 user staff  160 Mar 10 14:30 \x1b[01;34msrc\x1b[0m\n",
    "\x1b[0m-rw-r--r--  1 user staff 4096 Mar 10 14:30 \x1b[00mpackage.json\x1b[0m\n",
    "\x1b[0m-rw-r--r--  1 user staff  512 Mar 10 14:30 \x1b[00mtsconfig.json\x1b[0m\n",
    "\x1b[0m\x1b[01;32m-rwxr-xr-x\x1b[0m  1 user staff 8192 Mar 10 14:30 \x1b[01;32mindex.ts\x1b[0m\n",
    "\x1b[0m\x1b[01;36mlrwxr-xr-x\x1b[0m  1 user staff   24 Mar 10 14:30 \x1b[01;36mlink\x1b[0m -> \x1b[00mtarget\x1b[0m\n",
    "\x1b[38;5;208m-rw-r--r--\x1b[0m  1 user staff 2048 Mar 10 14:30 \x1b[38;5;208mREADME.md\x1b[0m\n",
    "\x1b[0mtotal 42\n",
    "\n",
  ];

  const combined = encoder.encode(lines.join(""));
  return { name: "real-world", data: fillAligned(combined, SIZE) };
}
