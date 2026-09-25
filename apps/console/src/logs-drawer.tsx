// The logs drawer: a running install's container output along the bottom of
// its page, the shape T3 Code's terminal drawer is.
//
// A strip the operator drags taller or shorter by its top edge, with a compact
// header carrying what it shows and the controls, and the lines below. Opened,
// it follows over the bridge for as long as it is open and stops the stream
// when it closes or the install changes underneath it. What it shows is
// logs.ts's view; the geometry is logs-drawer-size.ts; this file is the
// subscription, the drag and the drawing.

import { ArrowDownToLine, TerminalSquare, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
} from "react";
import type { DesktopBridge, LocalInstall } from "phoebe-agent/contracts";
import { Button } from "~/components/ui/button";
import { appendLogLine, EMPTY_LOGS, logsEnded, logsSeeded, type LogsView } from "./logs.ts";
import { draggedHeight } from "./logs-drawer-size.ts";

export function LogsDrawer({
  bridge,
  install,
  height,
  onHeightChange,
  onClose,
}: {
  bridge: DesktopBridge;
  install: LocalInstall;
  /** The drawer's height in pixels, owned by the page so it outlives a close. */
  height: number;
  onHeightChange: (height: number) => void;
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
  // pinned again when they scroll back down — or press the button.
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

  // The drag: the top edge follows the pointer, captured so a fast drag that
  // leaves the handle still lands on it.
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const onHandleDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      drag.current = { startY: event.clientY, startHeight: height };
      // Capture is a courtesy to a fast drag; a pointer that cannot be captured
      // (a synthetic one, or one already gone) still drags while it is over
      // the handle.
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // see above
      }
    },
    [height],
  );
  const onHandleMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const started = drag.current;
      if (started === null) return;
      onHeightChange(
        draggedHeight(started.startHeight, started.startY, event.clientY, window.innerHeight),
      );
    },
    [onHeightChange],
  );
  const onHandleUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <aside className="logs-drawer" aria-label="Container logs" style={{ height: `${height}px` }}>
      <div
        className="logs-drawer-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the logs drawer"
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
      />
      <header className="logs-drawer-bar">
        <span className="logs-drawer-tab">
          <TerminalSquare size={13} aria-hidden="true" />
          <span>{install.name}</span>
          <span className="muted mono">docker compose logs --follow phoebe</span>
        </span>
        <span className="logs-drawer-controls">
          {pinned ? null : (
            <Button
              variant="ghost"
              size="icon-xs"
              title="Follow the newest lines"
              aria-label="Follow the newest lines"
              onClick={() => setPinned(true)}
            >
              <ArrowDownToLine aria-hidden="true" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            title="Close the logs (Ctrl+`)"
            aria-label="Close the logs"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </span>
      </header>
      <pre className="logs-lines" ref={box} onScroll={onScroll}>
        {view.lines.length === 0 && view.ended === null ? (
          <span className="muted">Waiting for the container to print something…</span>
        ) : (
          view.lines.join("\n")
        )}
      </pre>
      {view.ended === null ? null : <p className="logs-drawer-ended muted">{view.ended}</p>}
    </aside>
  );
}
