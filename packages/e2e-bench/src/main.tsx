import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

// biome-ignore lint/style/noNonNullAssertion: root element guaranteed by index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
