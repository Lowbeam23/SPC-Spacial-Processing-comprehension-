import React, { useState, useRef, useEffect } from 'react';
import { ConsoleLog } from '../types';

interface ConsoleViewProps {
  logs: ConsoleLog[];
  onClear: () => void;
  onExecuteCommand: (command: string) => void;
  isPaused?: boolean;
  onTogglePause?: () => void;
  onClose?: () => void;
}

export const ConsoleView: React.FC<ConsoleViewProps> = ({
  logs,
  onClear,
  onExecuteCommand,
  isPaused = false,
  onTogglePause,
  onClose,
}) => {
  const [activeFilter, setActiveFilter] = useState<'all' | 'system' | 'bios' | 'tty' | 'disasm' | 'error'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [inputCommand, setInputCommand] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const filteredLogs = logs.filter((log) => {
    if (activeFilter === 'system' && log.type !== 'system') return false;
    if (activeFilter === 'bios' && log.type !== 'bios') return false;
    if (activeFilter === 'tty' && log.type !== 'tty') return false;
    if (activeFilter === 'disasm' && log.type !== 'disasm') return false;
    if (activeFilter === 'error' && log.type !== 'error' && log.type !== 'warn') return false;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        log.message.toLowerCase().includes(q) ||
        (log.pc !== undefined && log.pc.toString(16).toLowerCase().includes(q)) ||
        (log.details && log.details.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // Keep last 300 logs
  const displayLogs = filteredLogs.slice(-300);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [displayLogs.length, autoScroll]);

  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputCommand.trim()) return;
    onExecuteCommand(inputCommand.trim());
    setInputCommand('');
  };

  return (
    <div
      id="spc-system-console"
      className="flex flex-col bg-[#14141c] border-t-2 border-[#323242] font-mono text-xs shadow-inner h-56 shrink-0 select-text"
    >
      {/* Console Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-2.5 py-1 border-b border-zinc-800 gap-2 bg-[#1b1b24] select-none">
        <div className="flex items-center gap-2">
          <span className="font-bold text-zinc-200 flex items-center gap-1">
            <span className="text-emerald-400">❯</span> System Console
          </span>
          {isPaused && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase font-semibold tracking-wider">
              PAUSED
            </span>
          )}
          <span className="text-[11px] text-zinc-500">
            ({displayLogs.length} events{filteredLogs.length > 300 ? ' / 300 max' : ''})
          </span>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1 text-[11px]">
          {(['all', 'system', 'bios', 'tty', 'disasm', 'error'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setActiveFilter(filter)}
              className={`px-2 py-0.5 rounded-xs border text-[10px] uppercase font-bold transition-colors ${
                activeFilter === filter
                  ? 'bg-blue-900 text-white border-blue-500'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
              }`}
            >
              {filter}
            </button>
          ))}
        </div>

        {/* Console Controls */}
        <div className="flex items-center gap-2 text-[11px]">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search logs..."
            className="bg-zinc-950 border border-zinc-800 text-zinc-300 placeholder-zinc-600 px-1.5 py-0.5 rounded-xs text-[11px] w-28 focus:outline-none focus:border-zinc-600"
          />

          {onTogglePause && (
            <button
              onClick={onTogglePause}
              className={`px-1.5 py-0.5 rounded-xs border text-[10px] font-medium transition-colors ${
                isPaused
                  ? 'bg-amber-950 text-amber-300 border-amber-800'
                  : 'bg-zinc-950 text-zinc-400 hover:text-zinc-200 border-zinc-800'
              }`}
            >
              {isPaused ? '▶ Resume' : '⏸ Pause'}
            </button>
          )}

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-1.5 py-0.5 rounded-xs border text-[10px] ${
              autoScroll ? 'bg-zinc-800 text-zinc-200 border-zinc-700 font-semibold' : 'bg-zinc-950 text-zinc-500 border-zinc-800'
            }`}
          >
            Auto-Scroll
          </button>

          <button
            id="btn-dump-status"
            onClick={() => onExecuteCommand('dumpstatus')}
            title="Print current PC, VRAM pixel existence, and last 10 relevant events"
            className="px-2 py-0.5 rounded-xs bg-indigo-950 hover:bg-indigo-900 text-indigo-300 border border-indigo-700 text-[10px] font-semibold transition-colors"
          >
            dumpStatus()
          </button>

          <button
            onClick={onClear}
            title="Clear logs"
            className="px-2 py-0.5 rounded-xs bg-zinc-950 text-zinc-400 hover:text-amber-300 border border-zinc-800 text-[10px] font-medium"
          >
            Clear
          </button>

          {onClose && (
            <button
              onClick={onClose}
              title="Hide Console"
              className="px-2 py-0.5 rounded-xs bg-zinc-900 hover:bg-red-950 text-zinc-400 hover:text-red-300 border border-zinc-700 text-[10px] font-bold flex items-center gap-1"
            >
              <span>✕ Hide</span>
            </button>
          )}
        </div>
      </div>

      {/* Logs View Window */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-2 space-y-0.5 bg-[#0e0e14] select-text leading-tight font-mono text-[11px]"
      >
        {displayLogs.length === 0 ? (
          <div className="text-zinc-600 py-6 text-center select-none">No logs match the current filter.</div>
        ) : (
          displayLogs.map((log) => {
            const timeStr = new Date(log.timestamp).toLocaleTimeString();
            let color = 'text-zinc-300';
            if (log.type === 'error') color = 'text-red-400 font-bold';
            else if (log.type === 'warn') color = 'text-yellow-400';
            else if (log.type === 'tty') color = 'text-emerald-400 font-semibold';
            else if (log.type === 'disasm') color = 'text-cyan-400';
            else if (log.type === 'bios') color = 'text-purple-400 font-medium';

            return (
              <div key={log.id} className="flex items-start gap-1.5 py-0.5 px-1 hover:bg-zinc-900/60 rounded-xs">
                <span className="text-zinc-600 text-[10px] shrink-0 font-mono">[{timeStr}]</span>
                <span className="text-zinc-500 text-[10px] shrink-0 uppercase w-12 font-semibold">[{log.type}]</span>
                {log.pc !== undefined && (
                  <span className="text-zinc-400 text-[10px] shrink-0 font-mono">
                    0x{(log.pc >>> 0).toString(16).toUpperCase().padStart(8, '0')}
                  </span>
                )}
                <span className={`break-all flex-1 whitespace-pre-wrap ${color}`}>
                  {log.message}
                  {log.count && log.count > 1 ? (
                    <span className="ml-1.5 px-1.5 py-0.2 text-[9px] font-bold rounded bg-zinc-800 text-amber-400 border border-zinc-700 inline-block font-sans select-none">
                      (repeated{log.count > 2 ? ` x${log.count}` : ''})
                    </span>
                  ) : null}
                </span>
                {log.details && <span className="text-zinc-500 text-[10px] shrink-0">; {log.details}</span>}
              </div>
            );
          })
        )}
      </div>

      {/* Input Prompt */}
      <form
        onSubmit={handleCommandSubmit}
        className="flex items-center px-2 py-1 border-t border-zinc-800 bg-[#161620] select-none"
      >
        <span className="text-emerald-400 font-mono font-bold mr-2 text-xs">&gt;</span>
        <input
          id="console-command-input"
          type="text"
          value={inputCommand}
          onChange={(e) => setInputCommand(e.target.value)}
          placeholder="Command: 'run', 'pause', 'step', 'reset', 'pc', 'regs', 'disasm 0xBFC00000', 'clear', 'help'"
          className="flex-1 bg-transparent text-zinc-100 placeholder-zinc-600 focus:outline-none text-xs font-mono"
        />
        <button
          type="submit"
          className="px-2.5 py-0.5 rounded-xs bg-gradient-to-b from-zinc-700 to-zinc-900 hover:from-zinc-600 hover:to-zinc-800 text-zinc-200 text-[10px] border border-zinc-600 font-bold"
        >
          EXEC
        </button>
      </form>
    </div>
  );
};
