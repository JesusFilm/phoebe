// The browser entry point. The one place that decides which side of the relay
// client seam this bundle is running on.
//
// Today there is one arm, the browser's. The companion loads the same bundle from
// disk and hands it the desktop bridge's implementation instead (#553); that is a
// branch here and nowhere else in the app.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { createBrowserRelayClient } from "./relay-client.ts";
import "./console.css";

const root = document.getElementById("root");
if (root === null) throw new Error("the console's mount point is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App client={createBrowserRelayClient()} />
  </StrictMode>,
);
