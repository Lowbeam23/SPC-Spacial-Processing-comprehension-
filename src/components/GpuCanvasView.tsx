import React, { useRef, useEffect } from 'react';
import { Gpu } from '../emulator/gpu';
import { GpuState, EmulationStatus, VirtualDisc } from '../types';

interface GpuCanvasViewProps {
  gpu: Gpu;
  gpuState: GpuState;
  scanlines: boolean;
  status: EmulationStatus;
  lastError: string | null;
  hasBiosLoaded?: boolean;
  onOpenLoadBios?: () => void;
  onOpenMountDisc?: () => void;
  onBootBios?: () => void;
  onLaunchGame?: () => void;
  onEjectDisc?: () => void;
  hasDiscLoaded?: boolean;
  discName?: string;
  mountedDisc?: VirtualDisc | null;
}

export const GpuCanvasView: React.FC<GpuCanvasViewProps> = ({
  gpu,
  gpuState,
  scanlines,
  status,
  lastError,
  hasBiosLoaded = false,
  onOpenLoadBios,
  onOpenMountDisc,
  onBootBios,
  onLaunchGame,
  onEjectDisc,
  hasDiscLoaded = false,
  discName,
  mountedDisc,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showDiagnostics, setShowDiagnostics] = React.useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    gpu.targetCanvasCtx = ctx;

    const doRender = () => {
      const activeW = gpu.width || 640;
      const activeH = gpu.height || 480;
      if (canvas.width !== activeW || canvas.height !== activeH) {
        canvas.width = activeW;
        canvas.height = activeH;
      }
      gpu.renderToCanvas(
        ctx,
        canvas.width,
        canvas.height,
        scanlines,
        (hasBiosLoaded || status === 'running' || status === 'paused'),
        lastError
      );
    };

    doRender();
    gpu.onFrame = doRender;

    return () => {
      if (gpu.onFrame === doRender) {
        gpu.onFrame = undefined;
      }
    };
  }, [gpu, scanlines, status, lastError, hasBiosLoaded]);

  const isEmulating = (status === 'running' || status === 'paused');

  return (
    <div
      id="ps1-monitor-frame"
      className="relative flex items-center justify-center p-2 sm:p-3 rounded-sm bg-gradient-to-b from-[#1c1c22] to-[#101014] border-t-2 border-l-2 border-zinc-500 border-b-2 border-r-2 border-black shadow-2xl h-full max-h-full max-w-full"
    >
      <div className="relative aspect-[4/3] h-full max-h-full max-w-full w-auto bg-black border border-zinc-800 rounded-xs overflow-hidden shadow-inner flex items-center justify-center">
        <canvas
          id="ps1-gpu-canvas"
          ref={canvasRef}
          width={gpu.width || 640}
          height={gpu.height || 480}
          className="w-full h-full object-contain"
          style={{ imageRendering: 'pixelated' }}
        />

        {/* Live GPU & VBLANK Diagnostics HUD Bar (When Emulating) */}
        {isEmulating && (
          <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none z-20">
            <div className="flex items-center gap-1.5 bg-black/80 backdrop-blur-xs border border-zinc-700/80 px-2 py-0.5 rounded text-[10px] font-mono text-zinc-300 shadow-md">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-zinc-400">VBLANK IRQ:</span>
              <span className="text-emerald-300 font-bold">{(gpuState.vblankIrqCount ?? 0).toLocaleString()}</span>
              <span className="text-zinc-600">|</span>
              <span className="text-zinc-400">GP0:</span>
              <span className="text-cyan-300 font-bold">{(gpuState.gp0WriteCount ?? 0).toLocaleString()}</span>
              <span className="text-zinc-600">|</span>
              <span className="text-zinc-400">GP1:</span>
              <span className="text-purple-300 font-bold">{(gpuState.gp1WriteCount ?? 0).toLocaleString()}</span>
            </div>

            <button
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className="pointer-events-auto bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700 px-2 py-0.5 rounded text-[10px] font-mono shadow-md cursor-pointer transition-colors"
            >
              {showDiagnostics ? '✕ Hide HUD' : '📊 GPU HUD'}
            </button>
          </div>
        )}

        {/* Expanded Diagnostics Drawer */}
        {isEmulating && showDiagnostics && (
          <div className="absolute bottom-2 left-2 right-2 bg-black/90 backdrop-blur-md border border-zinc-700 p-2.5 rounded text-[10px] font-mono text-zinc-200 z-20 shadow-2xl space-y-1.5">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-1 font-bold text-zinc-100">
              <span className="flex items-center gap-1.5">
                <span className="text-emerald-400">●</span> GPU Hardware & Canvas Pipeline Monitor
              </span>
              <span className="text-[9px] text-zinc-400">
                Mode: {gpuState.displayMode} | Origin: ({gpuState.displayStartX ?? 0}, {gpuState.displayStartY ?? 0}) | Disp: {gpuState.displayDisabled ? 'DISABLED' : 'ENABLED'}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 pt-0.5 text-[10px]">
              <div className="bg-zinc-900/80 p-1.5 rounded border border-zinc-800">
                <div className="text-zinc-400 text-[9px]">GP0 Writes</div>
                <div className="text-cyan-300 font-bold text-xs mt-0.5">{(gpuState.gp0WriteCount ?? 0).toLocaleString()}</div>
                <div className="text-[8px] text-zinc-500">Prims & VRAM uploads</div>
              </div>
              <div className="bg-zinc-900/80 p-1.5 rounded border border-zinc-800">
                <div className="text-zinc-400 text-[9px]">GP1 Writes</div>
                <div className="text-purple-300 font-bold text-xs mt-0.5">{(gpuState.gp1WriteCount ?? 0).toLocaleString()}</div>
                <div className="text-[8px] text-zinc-500">Res & Display Ctrl</div>
              </div>
              <div className="bg-zinc-900/80 p-1.5 rounded border border-zinc-800">
                <div className="text-zinc-400 text-[9px]">DMA2 OT Packets</div>
                <div className="text-blue-300 font-bold text-xs mt-0.5">{(gpuState.dma2PacketCount ?? 0).toLocaleString()}</div>
                <div className="text-[8px] text-zinc-500">Linked-List Chains</div>
              </div>
              <div className="bg-zinc-900/80 p-1.5 rounded border border-zinc-800">
                <div className="text-zinc-400 text-[9px]">VBLANK IRQ 0</div>
                <div className="text-emerald-300 font-bold text-xs mt-0.5">{(gpuState.vblankIrqCount ?? 0).toLocaleString()}</div>
                <div className="text-[8px] text-zinc-500">60 Hz Interrupt Ticks</div>
              </div>
              <div className="bg-zinc-900/80 p-1.5 rounded border border-zinc-800">
                <div className="text-zinc-400 text-[9px]">VRAM Active Pixels</div>
                <div className="text-amber-300 font-bold text-xs mt-0.5">{(gpuState.totalVramNonZero ?? 0).toLocaleString()} px</div>
                <div className="text-[8px] text-zinc-500">1MB Video Buffer</div>
              </div>
            </div>
            {gpuState.vramFirst16WordsHex && (
              <div className="bg-zinc-950/80 p-1 rounded border border-zinc-800/80 text-[8px] text-zinc-400 truncate">
                <span className="text-zinc-500 font-semibold">VRAM [0..15]: </span>
                <span className="text-amber-200/90 font-mono">{gpuState.vramFirst16WordsHex}</span>
              </div>
            )}
          </div>
        )}

        {/* When Not Emulating: Display Dual-Branch Boot Selection Dashboard */}
        {!isEmulating && (
          <div
            id="dual-branch-dashboard-overlay"
            className="absolute inset-0 bg-black/92 flex flex-col items-center justify-center p-4 sm:p-6 text-center font-mono select-none z-30"
          >
            <div className="w-12 h-12 mb-2 rounded-full bg-gradient-to-b from-blue-900 to-indigo-950 border border-blue-400 flex items-center justify-center text-blue-200 text-xl font-bold shadow-xl">
              PS
            </div>

            <h2 className="text-zinc-100 text-sm sm:text-base font-bold tracking-wide uppercase mb-1">
              PlayStation 1 Dual-Branch Boot
            </h2>

            <p className="text-zinc-400 text-xs max-w-md mb-3">
              Strictly isolated boot paths: authentic Sony BIOS dashboard or direct HLE game runner.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-lg mb-3">
              {/* Branch A Card */}
              <div className={`p-2.5 rounded border text-left flex flex-col justify-between gap-2 ${
                !hasDiscLoaded && hasBiosLoaded
                  ? 'bg-blue-950/50 border-blue-500 shadow-md'
                  : 'bg-zinc-900/60 border-zinc-800 opacity-70'
              }`}>
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[11px] text-blue-300">BRANCH A: BIOS</span>
                    <span className="text-[9px] text-zinc-400">BEV=1 (ROM)</span>
                  </div>
                  <div className="text-[10px] text-zinc-400 mt-1">
                    Authentic Sony ROM @ 0xBFC00000. CD Player & Memory Cards.
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  {onBootBios && (
                    <button
                      id="overlay-boot-bios-btn"
                      disabled={hasDiscLoaded || !hasBiosLoaded}
                      onClick={onBootBios}
                      className={`w-full py-1.5 px-2 font-bold text-xs rounded border transition-all ${
                        !hasDiscLoaded && hasBiosLoaded
                          ? 'bg-gradient-to-b from-blue-600 to-blue-800 hover:from-blue-500 hover:to-blue-700 text-white border-blue-400 shadow-md cursor-pointer'
                          : 'bg-zinc-800 text-zinc-500 border-zinc-700 cursor-not-allowed'
                      }`}
                    >
                      ▶ Boot BIOS ROM
                    </button>
                  )}

                  {!hasBiosLoaded && onOpenLoadBios && (
                    <button
                      onClick={onOpenLoadBios}
                      className="w-full py-1 px-2 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-amber-300 rounded border border-zinc-700 font-bold"
                    >
                      📂 Load 512KB BIOS ROM
                    </button>
                  )}

                  {hasDiscLoaded && (
                    <div className="text-[9px] text-amber-400 text-center">
                      Locked: Eject media to boot BIOS
                    </div>
                  )}
                </div>
              </div>

              {/* Branch B Card */}
              <div className={`p-2.5 rounded border text-left flex flex-col justify-between gap-2 ${
                hasDiscLoaded
                  ? 'bg-emerald-950/50 border-emerald-500 shadow-md'
                  : 'bg-zinc-900/60 border-zinc-800 opacity-70'
              }`}>
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[11px] text-emerald-300">BRANCH B: HLE</span>
                    <span className="text-[9px] text-zinc-400">BEV=0 (RAM)</span>
                  </div>
                  <div className="text-[10px] text-zinc-400 mt-1">
                    Fast-Boot commercial PS1 games directly into RAM jump tables.
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  {onLaunchGame && (
                    <button
                      id="overlay-launch-game-btn"
                      disabled={!hasDiscLoaded}
                      onClick={onLaunchGame}
                      className={`w-full py-1.5 px-2 font-bold text-xs rounded border transition-all ${
                        hasDiscLoaded
                          ? 'bg-gradient-to-b from-emerald-600 to-emerald-800 hover:from-emerald-500 hover:to-emerald-700 text-white border-emerald-400 shadow-md cursor-pointer'
                          : 'bg-zinc-800 text-zinc-500 border-zinc-700 cursor-not-allowed'
                      }`}
                    >
                      ⚡ Launch Game (HLE)
                    </button>
                  )}

                  {hasDiscLoaded ? (
                    onEjectDisc && (
                      <button
                        onClick={onEjectDisc}
                        className="w-full py-1 px-2 text-[10px] bg-zinc-800 hover:bg-red-900/70 text-red-300 rounded border border-zinc-700"
                      >
                        ⏏ Eject / Clear Media
                      </button>
                    )
                  ) : (
                    onOpenMountDisc && (
                      <button
                        onClick={onOpenMountDisc}
                        className="w-full py-1 px-2 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-cyan-300 rounded border border-zinc-700 font-bold"
                      >
                        💿 Mount Disc / ZIP
                      </button>
                    )
                  )}

                  {!hasDiscLoaded && (
                    <div className="text-[9px] text-zinc-500 text-center">
                      Mount .ZIP / .CUE / .BIN / .ISO to enable
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="text-[10px] text-zinc-500 max-w-sm">
              Tip: Drag and drop any <span className="text-zinc-300">ZIP archive</span>, <span className="text-zinc-300">.BIN/.CUE</span>, or <span className="text-zinc-300">BIOS ROM</span> directly onto the window.
            </div>
          </div>
        )}

        {/* CRT Glass Reflection & Scanlines Overlay */}
        {scanlines && (
          <div
            className="absolute inset-0 pointer-events-none opacity-25"
            style={{
              backgroundImage:
                'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.4) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03))',
              backgroundSize: '100% 3px, 6px 100%',
            }}
          />
        )}
      </div>
    </div>
  );
};
