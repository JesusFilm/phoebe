// The logs pane: a running install's container output, beside its page.
//
// Opened, it follows over the bridge for as long as it is open, and stops the
// stream when it closes or the install changes underneath it. What it shows is
// logs.ts's view; this file is the subscription and the scrolling.

import { useEffect, useRef, useState, type UIEvent } from "react";
import type { DesktopBridge, LocalInstall } from "phoebe-agent/contracts";
import { appendLogLine, EMPTY_LOGS, logsEnded, logsSeeded, type LogsView } from "./logs.ts";

export function LogsPane({
  bridge,
  install,
  onClose,
}: {
  bridge: DesktopBridge;
  install: LocalInstall;
  onClose: () => void;
}) {
  const [view, setView] = useState<LogsView>(EMPTY_LOGS);

  // Followed again when the install's state moves: a container that came back
  // is a new stream, and the ended one below is not it.
  useEffect(() => {
    let live = true;
    setView(EMPTY_LOGS);
    bridge.logs.follow(install.dir).then(
      (held) => {
        if (live) setView(logsSeeded(held));
      },
      (error: unknown) => {
        if (live) {
          setView(logsEnded(EMPTY_LOGS, error instanceof Error ? error.message : String(error)));
        }
      },
    );
    const offLines = bridge.logs.lines((line) => {
      if (line.install === install.dir) setView((current) => appendLogLine(current, line.line));
    });
    const offEnded = bridge.logs.ended((end) => {
      if (end.install === install.dir) setView((current) => logsEnded(current, end.reason));
    });
    return () => {
      live = false;
      offLines();
      offEnded();
      void bridge.logs.stop(install.dir).catch(() => undefined);
    };
  }, [bridge, install.dir, install.state]);

  // Pinned to the bottom until the operator scrolls up to read something, and
  // pinned again when they scroll back down.
  const box = useRef<HTMLPreElement>(null);
  const [pinned, setPinned] = useState(true);
  useEffect(() => {
    const element = box.current;
    if (pinned && element !== null) element.scrollTop = element.scrollHeight;
  }, [view, pinned]);
  const onScroll = (event: UIEvent<HTMLPreElement>): void => {
    const element = event.currentTarget;
    setPinned(element.scrollTop + element.clientHeight >= element.scrollHeight - 4);
  };

  return (
    <aside className="logs-pane" aria-label="Container logs">
      <header>
        <span>
          Logs <span className="muted mono">docker compose logs --follow phoebe</span>
        </span>
        <button type="button" className="quiet" onClick={onClose}>
          Close
        </button>
      </header>
      <pre className="logs-lines" ref={box} onScroll={onScroll}>
        {view.lines.length === 0 && view.ended === null ? (
          <span className="muted">Waiting for the container to print something…</span>
        ) : (
          view.lines.join("\n")
        )}
      </pre>
      {view.ended === null ? null : <p className="ended muted">{view.ended}</p>}
    </aside>
  );
}
