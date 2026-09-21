import React, { useState, useRef, useEffect } from 'react';
import { ExecutionMode, EmulationStatus, BiosInfo } from '../types';

interface ZSNESMenuBarProps {
  status: EmulationStatus;
  mode: ExecutionMode;
  speedMultiplier: number;
  scanlines: boolean;
  showRegisters: boolean;
  showConsole: boolean;
  hasBiosLoaded?: boolean;
  biosInfo?: BiosInfo | null;
  hasDiscLoaded?: boolean;
  discName?: string;
  ips: number;
  pc: number;
  onOpenLoadBios: () => void;
  onUnloadBios: () => void;
  onOpenMountDisc: () => void;
  onEjectDisc: () => void;
  onRun: () => void;
  onPause: () => void;
  onStep: () => void;
  onReset: () => void;
  onModeChange: (mode: ExecutionMode) => void;
  onSpeedChange: (speed: number) => void;
  onToggleScanlines: () => void;
  onToggleRegisters: () => void;
  onToggleConsole: () => void;
  onClearLogs: () => void;
  onDumpStatus?: () => void;
}

export const ZSNESMenuBar: React.FC<ZSNESMenuBarProps> = ({
  status,
  mode,
  speedMultiplier,
  scanlines,
  showRegisters,
  showConsole,
  hasBiosLoaded = false,
  biosInfo,
  hasDiscLoaded = false,
  discName,
  ips,
  pc,
  onOpenLoadBios,
  onUnloadBios,
  onOpenMountDisc,
  onEjectDisc,
  onRun,
  onPause,
  onStep,
  onReset,
  onModeChange,
  onSpeedChange,
  onToggleScanlines,
  onToggleRegisters,
  onToggleConsole,
  onClearLogs,
  onDumpStatus,
}) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleMenu = (menuName: string) => {
    setOpenMenu(openMenu === menuName ? null : menuName);
  };

  const handleAction = (action: () => void) => {
    action();
    setOpenMenu(null);
  };

  return (
    <div
      ref={menuBarRef}
      id="zsnes-menu-bar"
      className="relative select-none font-mono text-xs z-50 flex items-center justify-between px-2 py-1 bg-gradient-to-b from-blue-700 via-blue-800 to-blue-950 border-b border-blue-900 shadow-md shrink-0"
      style={{
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3), 0 2px 4px rgba(0,0,0,0.5)',
      }}
    >
      {/* Menu Buttons on Left */}
      <div className="flex items-center gap-1">
        {/* Quick Drawer Icon */}
        <button
          id="menu-quick-drawer-btn"
          onClick={() => toggleMenu('quick')}
          className="px-2 py-0.5 rounded-sm bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-200 hover:from-zinc-600 hover:to-zinc-700 active:border-zinc-950 text-[11px] font-bold"
        >
          ↓
        </button>

        {/* [BIOS] Sub-Menu */}
        <div className="relative">
          <button
            id="menu-bios-btn"
            onClick={() => toggleMenu('bios')}
            className={`px-3 py-0.5 rounded-sm border text-[11px] font-bold tracking-wider uppercase transition-colors flex items-center gap-1 ${
              openMenu === 'bios'
                ? 'bg-blue-900 text-white border-blue-400'
                : 'bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-200 hover:text-white'
            }`}
          >
            BIOS
            {hasBiosLoaded && <span className="text-emerald-400 text-[9px]">●</span>}
          </button>

          {openMenu === 'bios' && (
            <div
              id="dropdown-bios"
              className="absolute left-0 top-full mt-1 w-64 bg-[#2c2c36] border-t-2 border-l-2 border-zinc-400 border-b-2 border-r-2 border-black shadow-2xl py-1 text-zinc-200 flex flex-col z-50"
            >
              <button
                id="menu-load-bios-btn"
                onClick={() => handleAction(onOpenLoadBios)}
                className="px-3 py-1.5 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group font-semibold text-emerald-300"
              >
                <span>📂 LOAD BIOS ROM (512KB)...</span>
              </button>

              {hasBiosLoaded && biosInfo && (
                <>
                  <div className="my-1 border-t border-zinc-700 border-b border-zinc-900" />
                  <div className="px-3 py-1 text-[10px] text-zinc-300 bg-zinc-800/80">
                    <div className="text-emerald-400 font-bold truncate">✓ {biosInfo.name}</div>
                    <div className="text-zinc-400">512 KB (Saved in Storage)</div>
                    <div className="text-zinc-400 truncate">{biosInfo.versionString}</div>
                  </div>
                  <button
                    id="menu-unload-bios-btn"
                    onClick={() => handleAction(onUnloadBios)}
                    className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group text-red-300 text-[11px]"
                  >
                    <span>🗑 UNLOAD / CLEAR SAVED BIOS</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* [DISC] Menu */}
        <div className="relative">
          <button
            id="menu-disc-btn"
            onClick={() => toggleMenu('disc')}
            className={`px-3 py-0.5 rounded-sm border text-[11px] font-bold tracking-wider uppercase transition-colors flex items-center gap-1 ${
              openMenu === 'disc'
                ? 'bg-blue-900 text-white border-blue-400'
                : 'bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-200 hover:text-white'
            }`}
          >
            DISC
            {hasDiscLoaded && <span className="text-cyan-400 text-[9px]">●</span>}
          </button>

          {openMenu === 'disc' && (
            <div
              id="dropdown-disc"
              className="absolute left-0 top-full mt-1 w-64 bg-[#2c2c36] border-t-2 border-l-2 border-zinc-400 border-b-2 border-r-2 border-black shadow-2xl py-1 text-zinc-200 flex flex-col z-50"
            >
              <button
                id="menu-mount-disc-btn"
                onClick={() => handleAction(onOpenMountDisc)}
                className="px-3 py-1.5 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group font-semibold text-cyan-300"
              >
                <span>💿 MOUNT DISC (.BIN / .ISO)...</span>
              </button>

              {hasDiscLoaded && (
                <>
                  <div className="my-1 border-t border-zinc-700 border-b border-zinc-900" />
                  <div className="px-3 py-1 text-[10px] text-zinc-300 bg-zinc-800/80">
                    <div className="text-cyan-400 font-bold truncate">💿 {discName || 'Disc Loaded'}</div>
                  </div>
                  <button
                    id="menu-eject-disc-btn"
                    onClick={() => handleAction(onEjectDisc)}
                    className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group text-red-300"
                  >
                    <span>⏏ EJECT DISC (OPEN TRAY)</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* [GAME] Menu */}
        <div className="relative">
          <button
            id="menu-game-btn"
            onClick={() => toggleMenu('game')}
            className={`px-3 py-0.5 rounded-sm border text-[11px] font-bold tracking-wider uppercase transition-colors ${
              openMenu === 'game'
                ? 'bg-blue-900 text-white border-blue-400'
                : 'bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-200 hover:text-white'
            }`}
          >
            GAME
          </button>

          {openMenu === 'game' && (
            <div
              id="dropdown-game"
              className="absolute left-0 top-full mt-1 w-56 bg-[#2c2c36] border-t-2 border-l-2 border-zinc-400 border-b-2 border-r-2 border-black shadow-2xl py-1 text-zinc-200 flex flex-col z-50"
            >
              {status === 'running' ? (
                <button
                  onClick={() => handleAction(onPause)}
                  className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group text-amber-300 font-semibold"
                >
                  <span>PAUSE</span>
                  <span className="text-[10px] text-zinc-400 group-hover:text-white">[ESC]</span>
                </button>
              ) : (
                <button
                  onClick={() => handleAction(onRun)}
                  className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group font-semibold text-emerald-300"
                >
                  <span>RUN</span>
                  <span className="text-[10px] text-zinc-400 group-hover:text-white">[ESC]</span>
                </button>
              )}

              <button
                onClick={() => handleAction(onStep)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>STEP</span>
                <span className="text-[10px] text-zinc-400 group-hover:text-white">[F10]</span>
              </button>

              <button
                onClick={() => handleAction(onReset)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>RESET</span>
                <span className="text-[10px] text-zinc-400 group-hover:text-white">[F2]</span>
              </button>
            </div>
          )}
        </div>

        {/* [CONFIG] Menu */}
        <div className="relative">
          <button
            id="menu-config-btn"
            onClick={() => toggleMenu('config')}
            className={`px-3 py-0.5 rounded-sm border text-[11px] font-bold tracking-wider uppercase transition-colors ${
              openMenu === 'config'
                ? 'bg-blue-900 text-white border-blue-400'
                : 'bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-200 hover:text-white'
            }`}
          >
            CONFIG
          </button>

          {openMenu === 'config' && (
            <div
              id="dropdown-config"
              className="absolute left-0 top-full mt-1 w-64 bg-[#2c2c36] border-t-2 border-l-2 border-zinc-400 border-b-2 border-r-2 border-black shadow-2xl py-1 text-zinc-200 flex flex-col z-50"
            >
              <div className="px-3 py-0.5 text-[10px] text-zinc-400 font-bold uppercase border-b border-zinc-700 mb-1">
                Execution Engine
              </div>
              <button
                onClick={() => handleAction(() => onModeChange('hybrid'))}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>{mode === 'hybrid' ? '● ' : '  '}HYBRID (JIT + INTERP)</span>
              </button>
              <button
                onClick={() => handleAction(() => onModeChange('jit'))}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>{mode === 'jit' ? '● ' : '  '}DYNAMIC RECOMPILER</span>
              </button>
              <button
                onClick={() => handleAction(() => onModeChange('interpreter'))}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>{mode === 'interpreter' ? '● ' : '  '}LINE-BY-LINE</span>
              </button>

              <div className="px-3 py-0.5 text-[10px] text-zinc-400 font-bold uppercase border-b border-zinc-700 my-1">
                Clock Speed
              </div>
              {[0.5, 1.0, 2.0, 5.0].map((s) => (
                <button
                  key={s}
                  onClick={() => handleAction(() => onSpeedChange(s))}
                  className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
                >
                  <span>
                    {speedMultiplier === s ? '● ' : '  '}
                    {s === 1.0 ? '1.0x (33.8 MHz REAL)' : `${s}x SPEED`}
                  </span>
                </button>
              ))}

              <div className="px-3 py-0.5 text-[10px] text-zinc-400 font-bold uppercase border-b border-zinc-700 my-1">
                Panels & Display
              </div>
              <button
                onClick={() => handleAction(onToggleConsole)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>{showConsole ? '✓ ' : '  '}SYSTEM CONSOLE</span>
                <span className="text-[10px] text-zinc-400 group-hover:text-white">[F12]</span>
              </button>
              <button
                onClick={() => handleAction(onToggleRegisters)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>{showRegisters ? '✓ ' : '  '}REGISTERS PANEL</span>
              </button>
              <button
                onClick={() => handleAction(onToggleScanlines)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>{scanlines ? '✓ ' : '  '}CRT SCANLINES</span>
              </button>
            </div>
          )}
        </div>

        {/* [CPU / MEM] Menu */}
        <div className="relative">
          <button
            id="menu-cpu-btn"
            onClick={() => toggleMenu('cpu')}
            className={`px-3 py-0.5 rounded-sm border text-[11px] font-bold tracking-wider uppercase transition-colors ${
              openMenu === 'cpu'
                ? 'bg-blue-900 text-white border-blue-400'
                : 'bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-200 hover:text-white'
            }`}
          >
            CPU / MEM
          </button>

          {openMenu === 'cpu' && (
            <div
              id="dropdown-cpu"
              className="absolute left-0 top-full mt-1 w-56 bg-[#2c2c36] border-t-2 border-l-2 border-zinc-400 border-b-2 border-r-2 border-black shadow-2xl py-1 text-zinc-200 flex flex-col z-50"
            >
              <button
                onClick={() => handleAction(onToggleRegisters)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>{showRegisters ? 'HIDE' : 'SHOW'} REGISTERS</span>
              </button>
              <button
                onClick={() => handleAction(onReset)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>RESET PC (0xBFC00000)</span>
              </button>
              <button
                onClick={() => handleAction(onStep)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>DISASM NEXT STEP</span>
              </button>
            </div>
          )}
        </div>

        {/* [GPU] Menu */}
        <div className="relative">
          <button
            id="menu-gpu-btn"
            onClick={() => toggleMenu('gpu')}
            className={`px-3 py-0.5 rounded-sm border text-[11px] font-bold tracking-wider uppercase transition-colors ${
              openMenu === 'gpu'
                ? 'bg-blue-900 text-white border-blue-400'
                : 'bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-200 hover:text-white'
            }`}
          >
            GPU
          </button>

          {openMenu === 'gpu' && (
            <div
              id="dropdown-gpu"
              className="absolute left-0 top-full mt-1 w-56 bg-[#2c2c36] border-t-2 border-l-2 border-zinc-400 border-b-2 border-r-2 border-black shadow-2xl py-1 text-zinc-200 flex flex-col z-50"
            >
              <button
                onClick={() => handleAction(onToggleScanlines)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>TOGGLE SCANLINES</span>
              </button>
            </div>
          )}
        </div>

        {/* [MISC] Menu */}
        <div className="relative">
          <button
            id="menu-misc-btn"
            onClick={() => toggleMenu('misc')}
            className={`px-3 py-0.5 rounded-sm border text-[11px] font-bold tracking-wider uppercase transition-colors ${
              openMenu === 'misc'
                ? 'bg-blue-900 text-white border-blue-400'
                : 'bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-200 hover:text-white'
            }`}
          >
            MISC
          </button>

          {openMenu === 'misc' && (
            <div
              id="dropdown-misc"
              className="absolute left-0 top-full mt-1 w-64 bg-[#2c2c36] border-t-2 border-l-2 border-zinc-400 border-b-2 border-r-2 border-black shadow-2xl py-1 text-zinc-200 flex flex-col z-50"
            >
              <button
                onClick={() => handleAction(onToggleConsole)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group font-semibold text-emerald-300"
              >
                <span>{showConsole ? 'HIDE' : 'SHOW'} SYSTEM CONSOLE</span>
                <span className="text-[10px] text-zinc-400 group-hover:text-white">[F12]</span>
              </button>
              <button
                onClick={() => handleAction(onClearLogs)}
                className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group"
              >
                <span>CLEAR CONSOLE LOGS</span>
              </button>
              {onDumpStatus && (
                <button
                  id="menu-dump-status-btn"
                  onClick={() => handleAction(onDumpStatus)}
                  className="px-3 py-1 text-left flex justify-between items-center hover:bg-[#b30059] hover:text-white group text-indigo-300 font-semibold"
                >
                  <span>DUMP STATUS (PC & VRAM)</span>
                </button>
              )}
              <div className="my-1 border-t border-zinc-700 border-b border-zinc-900" />
              <div className="px-3 py-1 text-[10px] text-zinc-400 font-mono">
                SPC PS1 Emulator V0.1 | made with gemini
              </div>
            </div>
          )}
        </div>

        {/* Direct Quick Toggle for Console */}
        <button
          id="menu-toggle-console-btn"
          onClick={onToggleConsole}
          title="Toggle System Console (F12)"
          className={`px-2.5 py-0.5 rounded-sm border text-[11px] font-bold tracking-wider uppercase transition-colors flex items-center gap-1 ${
            showConsole
              ? 'bg-gradient-to-b from-emerald-800 to-emerald-950 text-emerald-200 border-emerald-500 shadow-inner'
              : 'bg-gradient-to-b from-zinc-700 to-zinc-800 border-t border-l border-zinc-500 border-b border-r border-zinc-950 text-zinc-300 hover:text-white'
          }`}
        >
          <span>❯_ CONSOLE</span>
          {showConsole && <span className="text-emerald-400 text-[9px]">●</span>}
        </button>
      </div>

      {/* Center/Right: IPS & Status moved to the Top Menu Bar */}
      <div className="flex items-center gap-2 text-[11px] font-mono">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-black/40 border border-blue-950 text-zinc-300">
          <span className="text-zinc-400">IPS:</span>
          <span className="font-bold text-amber-300">{ips > 0 ? ips.toLocaleString() : '0'}</span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-400">PC:</span>
          <span className="text-cyan-300 font-mono">0x{pc.toString(16).toUpperCase().padStart(8, '0')}</span>
          <span className="text-zinc-600">|</span>
          <span
            className={`font-bold px-1 rounded-xs text-[10px] ${
              status === 'running'
                ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                : status === 'paused'
                ? 'bg-amber-950 text-amber-300 border border-amber-700'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
            }`}
          >
            {status.toUpperCase()}
          </span>
        </div>

        {/* Retro Window Controls on Right */}
        <div className="flex items-center gap-1 text-zinc-200">
          <button
            onClick={() => handleAction(onPause)}
            title="Minimize / Pause"
            className="w-4 h-4 rounded-xs bg-gradient-to-b from-zinc-700 to-zinc-900 border border-zinc-500 flex items-center justify-center text-[10px] hover:bg-zinc-600 active:border-black font-bold"
          >
            _
          </button>
          <button
            onClick={() => handleAction(onRun)}
            title="Maximize / Run"
            className="w-4 h-4 rounded-xs bg-gradient-to-b from-zinc-700 to-zinc-900 border border-zinc-500 flex items-center justify-center text-[10px] hover:bg-zinc-600 active:border-black font-bold"
          >
            □
          </button>
          <button
            onClick={() => handleAction(onReset)}
            title="Reset"
            className="w-4 h-4 rounded-xs bg-gradient-to-b from-zinc-700 to-zinc-900 border border-zinc-500 flex items-center justify-center text-[10px] hover:bg-red-800 active:border-black font-bold"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
};
