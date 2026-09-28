// The entry point. The one place that decides which surface this bundle is
// running on.
//
// The companion's preload puts the desktop bridge on a global before this module
// runs; a plain browser has nothing there. So the branch is a read of that
// global, it happens once, and every component below takes the answer as a prop
// rather than looking for itself (#522 §4).

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { desktopBridge } from "./companion.ts";
import { followSystemTheme } from "./theme.ts";
// Tailwind and the Coss UI theme first, the console's own sheet after, so the
// console's rules win where the two say different things about one element.
import "./index.css";
import "./console.css";

const root = document.getElementById("root");
if (root === null) throw new Error("the console's mount point is missing from index.html");

followSystemTheme();
const bridge = desktopBridge();

createRoot(root).render(
  <StrictMode>
    {bridge === null ? <App surface="browser" /> : <App surface="companion" bridge={bridge} />}
  </StrictMode>,
);
