// The entry point. The one place that decides which side of the relay-client
// seam this bundle is running on.
//
// The companion's preload puts the desktop bridge on a global before this module
// runs; a browser the relay served the same files to has nothing there. So the
// branch is a read of that global, it happens once, and every component below
// takes the answer as a prop rather than looking for itself (#522 §4).

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { desktopBridge } from "./companion.ts";
import { createBridgeRelayClient, createBrowserRelayClient } from "./relay-client.ts";
import "./console.css";

const root = document.getElementById("root");
if (root === null) throw new Error("the console's mount point is missing from index.html");

const bridge = desktopBridge();

createRoot(root).render(
  <StrictMode>
    {bridge === null ? (
      <App client={createBrowserRelayClient()} surface="browser" />
    ) : (
      <App client={createBridgeRelayClient(bridge)} surface="companion" bridge={bridge} />
    )}
  </StrictMode>,
);
