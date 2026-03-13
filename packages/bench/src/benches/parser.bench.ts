import { bench, describe } from "vitest";
import { scenarios } from "../generators/index.js";
import { createReactTermHarness, type ReactTermHarness } from "../harness/react-term-harness.js";
import { createXtermHarness, type XtermHarness } from "../harness/xterm-harness.js";

for (const scenario of scenarios) {
  describe(scenario.name, () => {
    let rt: ReactTermHarness;
    let xt: XtermHarness;

    bench(
      "react-term",
      () => {
        rt.write(scenario.data);
      },
      {
        setup() {
          rt = createReactTermHarness();
        },
      },
    );

    bench(
      "xterm-headless",
      async () => {
        await xt.write(scenario.data);
      },
      {
        setup() {
          xt = createXtermHarness();
        },
        teardown() {
          xt.dispose();
        },
      },
    );
  });
}
