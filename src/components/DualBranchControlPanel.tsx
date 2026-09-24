import React from 'react';
import { BootMode, BiosInfo, EmulationStatus, VirtualDisc } from '../types';

interface DualBranchControlPanelProps {
  hasBiosLoaded: boolean;
  biosInfo: BiosInfo | null;
  hasDiscLoaded: boolean;
  mountedDisc: VirtualDisc | null;
  discName?: string;
  status: EmulationStatus;
  onBootBios: () => void;
  onLaunchGame: () => void;
  onOpenLoadBios: () => void;
  onUnloadBios: () => void;
  onOpenMountDisc: () => void;
  onEjectDisc: () => void;
  onPause: () => void;
  onStep: () => void;
  onReset: () => void;
}

export const DualBranchControlPanel: React.FC<DualBranchControlPanelProps> = ({
  hasBiosLoaded,
  biosInfo,
  hasDiscLoaded,
  mountedDisc,
  discName,
  status,
  onBootBios,
  onLaunchGame,
  onOpenLoadBios,
  onUnloadBios,
  onOpenMountDisc,
  onEjectDisc,
  onPause,
  onStep,
  onReset,
}) => {
  const isRunning = status === 'running';

  return (
    <div
      id="dual-branch-control-panel"
      className="bg-[#181822] border border-zinc-700/80 rounded shadow-lg p-2 sm:p-2.5 font-mono text-xs flex flex-col gap-2 shrink-0 select-none text-zinc-200"
    >
      {/* Header Bar */}
      <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          <span className="font-bold tracking-wider text-zinc-100 uppercase">
            PS1 Dual-Branch Boot Architecture
          </span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-zinc-400">STATE:</span>
          <span
            className={`font-bold px-1.5 py-0.2 rounded uppercase border ${
              hasDiscLoaded
                ? 'bg-cyan-950 text-cyan-300 border-cyan-700'
                : 'bg-zinc-800 text-zinc-300 border-zinc-600'
            }`}
          >
            {hasDiscLoaded ? 'Disc / ZIP Mounted' : 'No Disc (BIOS Mode)'}
          </span>
        </div>
      </div>

      {/* Primary Dual-Branch Buttons (Strict Mutual Exclusion) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {/* Branch A: Authentic BIOS / Dashboard */}
        <div
          className={`p-2 rounded border flex flex-col justify-between gap-1.5 transition-all ${
            !hasDiscLoaded
              ? 'bg-blue-950/40 border-blue-600/80 shadow-md'
              : 'bg-zinc-900/40 border-zinc-800 opacity-60'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-bold text-[11px] text-blue-300 flex items-center gap-1.5">
              <span>● BRANCH A:</span>
              <span className="text-zinc-300 font-normal">Authentic BIOS</span>
            </span>
            <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-zinc-800 text-zinc-400">
              BEV=1 ROM (0xBFC00000)
            </span>
          </div>

          <div className="text-[10px] text-zinc-400 leading-tight">
            Executes Sony ROM for CD Player, Sound, and Memory Card management.
          </div>

          <div className="flex items-center gap-1.5 pt-1">
            <button
              id="boot-bios-dashboard-btn"
              disabled={hasDiscLoaded || !hasBiosLoaded}
              onClick={onBootBios}
              title={
                hasDiscLoaded
                  ? 'Locked: Eject media first to boot authentic BIOS'
                  : !hasBiosLoaded
                  ? 'Please load a 512KB BIOS ROM first'
                  : 'Boot Authentic Sony BIOS ROM'
              }
              className={`flex-1 py-1.5 px-2 rounded font-bold text-[11px] flex items-center justify-center gap-1.5 border transition-all ${
                !hasDiscLoaded && hasBiosLoaded
                  ? 'bg-gradient-to-b from-blue-600 to-blue-800 hover:from-blue-500 hover:to-blue-700 text-white border-blue-400 shadow-sm active:translate-y-px cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700 cursor-not-allowed'
              }`}
            >
              <span>▶ Boot BIOS / Dashboard</span>
            </button>

            {hasBiosLoaded ? (
              <button
                onClick={onUnloadBios}
                title="Unload BIOS ROM"
                className="px-2 py-1.5 rounded bg-zinc-800 hover:bg-red-900/60 text-zinc-400 hover:text-red-200 border border-zinc-700 text-[10px]"
              >
                Clear
              </button>
            ) : (
              <button
                onClick={onOpenLoadBios}
                title="Load 512KB BIOS ROM"
                className="px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-amber-300 hover:text-white border border-zinc-700 text-[10px] font-bold"
              >
                Load ROM
              </button>
            )}
          </div>

          {hasDiscLoaded && (
            <div className="text-[9px] text-amber-400/90 font-mono">
              ⚠️ Locked out: Media mounted in CD tray. Eject media to enable.
            </div>
          )}
        </div>

        {/* Branch B: Fast-Boot / HLE Game Runner */}
        <div
          className={`p-2 rounded border flex flex-col justify-between gap-1.5 transition-all ${
            hasDiscLoaded
              ? 'bg-emerald-950/40 border-emerald-500/80 shadow-md'
              : 'bg-zinc-900/40 border-zinc-800 opacity-60'
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-bold text-[11px] text-emerald-300 flex items-center gap-1.5">
              <span>⚡ BRANCH B:</span>
              <span className="text-zinc-300 font-normal">HLE Game Runner</span>
            </span>
            <span className="text-[9px] font-mono px-1 py-0.2 rounded bg-zinc-800 text-zinc-400">
              BEV=0 RAM Jump Tables
            </span>
          </div>

          <div className="text-[10px] text-zinc-400 leading-tight">
            Directly boots commercial games into RAM with HLE kernel vectors.
          </div>

          <div className="flex items-center gap-1.5 pt-1">
            <button
              id="launch-game-hle-btn"
              disabled={!hasDiscLoaded}
              onClick={onLaunchGame}
              title={
                hasDiscLoaded
                  ? 'Launch game with HLE Fast Boot'
                  : 'Disabled: Mount a PS1 Disc or ZIP Archive first'
              }
              className={`flex-1 py-1.5 px-2 rounded font-bold text-[11px] flex items-center justify-center gap-1.5 border transition-all ${
                hasDiscLoaded
                  ? 'bg-gradient-to-b from-emerald-600 to-emerald-800 hover:from-emerald-500 hover:to-emerald-700 text-white border-emerald-400 shadow-sm active:translate-y-px cursor-pointer'
                  : 'bg-zinc-800 text-zinc-500 border-zinc-700 cursor-not-allowed'
              }`}
            >
              <span>⚡ Launch PS1 Game (HLE Fast Boot)</span>
            </button>

            {hasDiscLoaded ? (
              <button
                id="eject-media-btn"
                onClick={onEjectDisc}
                title="Eject / Clear Media from CD-ROM drive"
                className="px-2.5 py-1.5 rounded bg-zinc-800 hover:bg-red-900/80 text-red-300 hover:text-white border border-zinc-700 text-[10px] font-bold"
              >
                ⏏ Eject Media
              </button>
            ) : (
              <button
                id="mount-disc-btn"
                onClick={onOpenMountDisc}
                title="Mount Disc or ZIP Archive"
                className="px-2 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-cyan-300 hover:text-white border border-zinc-700 text-[10px] font-bold"
              >
                Mount Media
              </button>
            )}
          </div>

          {!hasDiscLoaded && (
            <div className="text-[9px] text-zinc-500 font-mono">
              ℹ️ Disabled: Mount a .ZIP, .CUE, .BIN, or .ISO file to enable.
            </div>
          )}
        </div>
      </div>

      {/* Media Details & Quick Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-zinc-800 text-[10px]">
        {/* Disc / BIOS Status Summary */}
        <div className="flex items-center gap-2 font-mono truncate">
          <span className="text-zinc-400">Media:</span>
          {hasDiscLoaded ? (
            <span className="text-cyan-300 font-bold truncate">
              💿 {mountedDisc?.name || discName || 'Game Disc Mounted'}
              {mountedDisc?.primaryExecutable ? ` (${mountedDisc.primaryExecutable})` : ''}
            </span>
          ) : (
            <span className="text-zinc-500 italic">No disc in tray</span>
          )}

          <span className="text-zinc-600">|</span>

          <span className="text-zinc-400">BIOS:</span>
          {hasBiosLoaded && biosInfo ? (
            <span className="text-emerald-400 font-semibold truncate">
              ✓ {biosInfo.name}
            </span>
          ) : (
            <span className="text-amber-500/80 italic">No BIOS ROM</span>
          )}
        </div>

        {/* Playback Controls */}
        <div className="flex items-center gap-1 shrink-0">
          {isRunning ? (
            <button
              onClick={onPause}
              className="px-2 py-0.5 rounded bg-amber-800 hover:bg-amber-700 text-white font-bold border border-amber-600 text-[10px]"
            >
              Pause
            </button>
          ) : (
            <button
              onClick={hasDiscLoaded ? onLaunchGame : onBootBios}
              className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white font-bold border border-zinc-500 text-[10px]"
            >
              Resume
            </button>
          )}

          <button
            onClick={onStep}
            className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[10px]"
          >
            Step
          </button>

          <button
            onClick={onReset}
            className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[10px]"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
};
