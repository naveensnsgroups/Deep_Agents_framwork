import { useEffect, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import { PTY_URL, authProtocols } from "../../lib/ws-client";
import { useTheme, type Theme } from "../../lib/theme";
import "@xterm/xterm/css/xterm.css";

interface Props {
  projectRoot: string;
  onClose: () => void;
}

/** xterm renders its own canvas, so its colors are a runtime option, not CSS — matched to the
 * app's dark (neutral-950) and light (white) surfaces. */
function xtermTheme(theme: Theme): ITheme {
  return theme === "light"
    ? { background: "#ffffff", foreground: "#1a1a1a", cursor: "#1a1a1a" }
    : { background: "#0a0a0a", foreground: "#e5e5e5" };
}

/**
 * A real interactive shell, unlike the tool-result cards in chat which only show a
 * command's captured output after it finishes. One PTY process per mount, killed on
 * unmount — reopening the panel starts a fresh shell rather than reattaching, since
 * the server doesn't keep terminals alive past their WebSocket connection.
 */
export function TerminalPanel({ projectRoot, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [theme] = useTheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: xtermTheme(theme),
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    const ws = new WebSocket(PTY_URL, authProtocols());

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "init", cwd: projectRoot, cols: term.cols, rows: term.rows }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "data") term.write(msg.data);
      else if (msg.type === "exit") term.write(`\r\n\x1b[90m[process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
    };
    ws.onerror = () => term.write("\r\n\x1b[31m[terminal connection failed]\x1b[0m\r\n");

    const dataListener = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      dataListener.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
    };
    // theme is intentionally excluded — recreating the terminal on every toggle would kill the
    // running shell process just to change colors. See the effect below for a live update instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  // Applies a theme change to the already-open terminal without touching the shell process —
  // xterm.js's `options` setter re-renders existing content with the new palette in place.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme);
  }, [theme]);

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-neutral-800 light:border-neutral-200 bg-[#0a0a0a] light:bg-white">
      <div className="flex flex-none items-center justify-between border-b border-neutral-800 light:border-neutral-200 bg-neutral-900 light:bg-neutral-50 px-2.5 py-1">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">Terminal</span>
        <button onClick={onClose} title="Close terminal" className="cursor-pointer text-neutral-500 hover:text-white light:hover:text-neutral-900">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  );
}
