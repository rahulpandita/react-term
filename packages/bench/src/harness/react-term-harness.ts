import { BufferSet, VTParser } from "@react-term/core";

export interface ReactTermHarness {
  write(data: Uint8Array): void;
}

export function createReactTermHarness(cols = 80, rows = 24): ReactTermHarness {
  const bufferSet = new BufferSet(cols, rows, 0);
  const parser = new VTParser(bufferSet);
  return {
    write(data: Uint8Array) {
      parser.write(data);
    },
  };
}
