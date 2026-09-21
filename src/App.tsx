/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Ps1Emulator } from './emulator/ps1';
import { CpuState, GpuState, EmulationStatus, ExecutionMode, BiosInfo, CdromState, ConsoleLog } from './types';
import { GpuCanvasView } from './components/GpuCanvasView';
import { CpuRegistersView } from './components/CpuRegistersView';
import { ZSNESMenuBar } from './components/ZSNESMenuBar';
import { StarryBackground } from './components/StarryBackground';
import { ConsoleView } from './components/ConsoleView';
import { disassemble } from './emulator/disassembler';

export default function App() {
  const emulatorRef = useRef<Ps1Emulator | null>(null);
  const biosFileInputRef = useRef<HTMLInputElement | null>(null);
  const discFileInputRef = useRef<HTMLInputElement | null>(null);

  // Lazy initialize emulator
  if (!emulatorRef.current) {
    emulatorRef.current = new Ps1Emulator();
  }
  const emu = emulatorRef.current;

  // React state for UI updates
  const [cpuState, setCpuState] = useState<CpuState>(() => emu.cpu.getState());
  const [gpuState, setGpuState] = useState<GpuState>(() => emu.gpu.getState());
  const [cdromState, setCdromState] = useState<CdromState>(() => emu.getCdromState());
  const [status, setStatus] = useState<EmulationStatus>(emu.status);
  const [mode, setMode] = useState<ExecutionMode>(emu.mode);
  const [speedMultiplier, setSpeedMultiplier] = useState<number>(emu.speedMultiplier);
  const [hasBiosLoaded, setHasBiosLoaded] = useState<boolean>(emu.hasBiosLoaded);
  const [biosInfo, setBiosInfo] = useState<BiosInfo | null>(emu.currentBiosInfo);
  const [ips, setIps] = useState<number>(0);
  const [lastError, setLastError] = useState<string | null>(null);

  // Panels and Display toggles
  const [logs, setLogs] = useState<ConsoleLog[]>([]);
  const [showConsole, setShowConsole] = useState<boolean>(true);
  const [showRegisters, setShowRegisters] = useState<boolean>(false);
  const [scanlines, setScanlines] = useState<boolean>(true);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  useEffect(() => {
    // Attach event listeners to the emulator
    emu.onStateChange = (newCpu: CpuState, newGpu: GpuState, newStatus: EmulationStatus, err: string | null, newCdrom?: CdromState) => {
      setCpuState(newCpu);
      setGpuState(newGpu);
      setStatus(newStatus);
      setLastError(err);
      setIps(emu.currentIps);
      setHasBiosLoaded(emu.hasBiosLoaded);
      setBiosInfo(emu.currentBiosInfo);
      if (newCdrom) {
        setCdromState(newCdrom);
      }
    };

    emu.onLog = (log: ConsoleLog) => {
      setLogs((prev) => {
        if (prev.length > 0) {
          const last = prev[prev.length - 1];
          if (last.type === log.type && last.message === log.message && last.pc === log.pc) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                count: (last.count || 1) + 1,
                timestamp: log.timestamp,
              },
            ];
          }
        }
        return [...prev.slice(-300), log];
      });
    };

    // Global keyboard shortcuts (ESC for Run/Pause, F2 for Reset, F10 for Step, F12 for Console)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (emu.status === 'running') {
          handlePause();
        } else {
          handleRun();
        }
      } else if (e.key === 'F2') {
        e.preventDefault();
        handleReset();
      } else if (e.key === 'F10') {
        e.preventDefault();
        handleStep();
      } else if (e.key === 'F12' || e.key === '`') {
        e.preventDefault();
        setShowConsole((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      emu.pause();
    };
  }, [emu]);

  // Handle BIOS file selection (512KB authentic dump)
  const handleLoadBiosFile = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const uint8 = new Uint8Array(buffer);
      await emu.loadCustomBios(uint8, file.name, true);
      setHasBiosLoaded(emu.hasBiosLoaded);
      setBiosInfo(emu.currentBiosInfo);
      setCpuState(emu.cpu.getState());
      setGpuState(emu.gpu.getState());
      setStatus(emu.status);
    } catch (err: any) {
      alert(err.message || 'Failed to load BIOS ROM. Please provide an authentic 512KB PS1 BIOS file.');
    }
  };

  // Handle BIOS unload / clear
  const handleUnloadBios = async () => {
    await emu.unloadBios();
    setHasBiosLoaded(false);
    setBiosInfo(null);
    setCpuState(emu.cpu.getState());
    setGpuState(emu.gpu.getState());
    setStatus(emu.status);
  };

  // Handle Game Disc Mount
  const handleMountDisc = (fileBuffer: ArrayBuffer, fileName: string) => {
    try {
      emu.mountDisc(fileBuffer, fileName);
      setCdromState(emu.getCdromState());
      setCpuState(emu.cpu.getState());
      setGpuState(emu.gpu.getState());
      setStatus(emu.status);
    } catch (err: any) {
      alert(`Failed to mount disc: ${err.message || err}`);
    }
  };

  const handleEjectDisc = () => {
    emu.ejectDisc();
    setCdromState(emu.getCdromState());
  };

  const handleBiosFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      handleLoadBiosFile(file);
      e.target.value = '';
    }
  };

  const handleDiscFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      file.arrayBuffer().then((buf) => handleMountDisc(buf, file.name));
      e.target.value = '';
    }
  };

  const handleOpenLoadBios = () => {
    biosFileInputRef.current?.click();
  };

  const handleOpenMountDisc = () => {
    discFileInputRef.current?.click();
  };

  const handleRun = () => {
    emu.start();
    setStatus(emu.status);
  };

  const handlePause = () => {
    emu.pause();
    setStatus(emu.status);
    setCpuState(emu.cpu.getState());
  };

  const handleStep = () => {
    emu.step();
    setCpuState(emu.cpu.getState());
    setStatus(emu.status);
  };

  const handleReset = () => {
    emu.reset();
    setCpuState(emu.cpu.getState());
    setGpuState(emu.gpu.getState());
    setStatus(emu.status);
    if (emu.hasBiosLoaded) {
      emu.start();
    }
  };

  const handleModeChange = (newMode: ExecutionMode) => {
    setMode(newMode);
    emu.setExecutionMode(newMode);
  };

  const handleSpeedChange = (newSpeed: number) => {
    setSpeedMultiplier(newSpeed);
    emu.setSpeedMultiplier(newSpeed);
  };

  const handleClearLogs = () => {
    setLogs([]);
    emu.addLog('system', 'Console logs cleared.');
  };

  const handleExecuteCommand = (rawCommand: string) => {
    const parts = rawCommand.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg1 = parts[1];

    emu.addLog('system', `> ${rawCommand}`);

    switch (cmd) {
      case 'help':
        emu.addLog('system', 'Available commands: dumpstatus, run, pause, step, reset, pc, regs, bios, disc, clear, cls, speed <n>, mode <hybrid|jit|interpreter>, disasm <hex_addr>, dump <hex_addr>');
        break;
      case 'dumpstatus':
      case 'dumpstatus()':
      case 'status':
        emu.dumpStatus();
        break;
      case 'run':
        handleRun();
        break;
      case 'pause':
      case 'stop':
        handlePause();
        break;
      case 'step':
        handleStep();
        break;
      case 'reset':
        handleReset();
        break;
      case 'cls':
      case 'clear':
        handleClearLogs();
        break;
      case 'pc':
        emu.addLog('system', `Current PC: 0x${emu.cpu.pc.toString(16).toUpperCase()}`);
        break;
      case 'regs':
        setShowRegisters(true);
        emu.addLog('system', `PC=0x${emu.cpu.pc.toString(16).toUpperCase()} SP=0x${emu.cpu.regs[29].toString(16).toUpperCase()} RA=0x${emu.cpu.regs[31].toString(16).toUpperCase()}`);
        break;
      case 'bios':
        if (emu.hasBiosLoaded && emu.currentBiosInfo) {
          emu.addLog('bios', `BIOS: ${emu.currentBiosInfo.name} (${emu.currentBiosInfo.versionString})`);
        } else {
          emu.addLog('warn', 'No BIOS loaded. Please load a 512KB PS1 BIOS ROM.');
        }
        break;
      case 'disc':
        if (emu.cdrom.hasDisc) {
          emu.addLog('system', `Disc: ${emu.cdrom.discInfo?.name || 'Mounted'} (${emu.cdrom.discInfo?.sectors || 0} sectors)`);
        } else {
          emu.addLog('system', 'CD-ROM drive tray is empty.');
        }
        break;
      case 'speed':
        if (arg1) {
          const s = parseFloat(arg1);
          if (!isNaN(s) && s > 0) {
            handleSpeedChange(s);
            emu.addLog('system', `Speed multiplier set to ${s}x`);
          }
        }
        break;
      case 'mode':
        if (arg1 && (arg1 === 'hybrid' || arg1 === 'jit' || arg1 === 'interpreter')) {
          handleModeChange(arg1 as ExecutionMode);
        } else {
          emu.addLog('warn', 'Usage: mode <hybrid | jit | interpreter>');
        }
        break;
      case 'disasm': {
        const addr = arg1 ? parseInt(arg1, 16) : emu.cpu.pc;
        if (!isNaN(addr)) {
          for (let i = 0; i < 4; i++) {
            const a = (addr + i * 4) >>> 0;
            const op = emu.memory.read32(a);
            emu.addLog('disasm', `0x${a.toString(16).toUpperCase().padStart(8, '0')}: ${disassemble(a, op)}`);
          }
        }
        break;
      }
      case 'dump': {
        const addr = arg1 ? parseInt(arg1, 16) : emu.cpu.pc;
        if (!isNaN(addr)) {
          let line = `0x${addr.toString(16).toUpperCase().padStart(8, '0')}: `;
          for (let i = 0; i < 16; i++) {
            const b = emu.memory.read8((addr + i) >>> 0);
            line += b.toString(16).padStart(2, '0').toUpperCase() + ' ';
          }
          emu.addLog('system', line);
        }
        break;
      }
      default:
        emu.addLog('warn', `Unknown command "${cmd}". Type 'help' for available commands.`);
        break;
    }
  };

  // Drag and drop handlers on the window
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.iso') || lower.endsWith('.cue') || lower.endsWith('.img') || file.size > 524288) {
        file.arrayBuffer().then((buf) => handleMountDisc(buf, file.name));
      } else {
        handleLoadBiosFile(file);
      }
    }
  };

  return (
    <div
      id="spc-app-container"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="h-screen w-screen max-h-screen max-w-screen bg-[#111116] text-zinc-200 flex flex-col p-1 sm:p-2 font-sans select-none overflow-hidden"
    >
      {/* Hidden File Inputs for BIOS and Disc */}
      <input
        ref={biosFileInputRef}
        type="file"
        accept=".bin,.rom,.img,.bios,*"
        className="hidden"
        onChange={handleBiosFileInputChange}
      />
      <input
        ref={discFileInputRef}
        type="file"
        accept=".iso,.bin,.cue,.img,.exe,*"
        className="hidden"
        onChange={handleDiscFileInputChange}
      />

      {/* Retro Emulator Window Container - Expands to full available window */}
      <div
        id="zsnes-emulator-window"
        className="w-full h-full rounded-md border-2 border-[#828296] bg-[#1a1a24] shadow-2xl flex flex-col overflow-hidden min-h-0"
        style={{
          boxShadow: '0 16px 48px rgba(0,0,0,0.85), inset 1px 1px 0 rgba(255,255,255,0.4)',
        }}
      >
        {/* Retro Window Title Bar */}
        <div
          id="window-title-bar"
          className="bg-gradient-to-r from-[#d4d4dc] via-[#e2e2ea] to-[#c8c8d2] text-[#1a1a24] px-2 py-0.5 border-b border-[#6e6e80] flex items-center justify-between font-mono text-xs font-bold shrink-0"
        >
          {/* Left Window Control Dot */}
          <div className="flex items-center gap-1.5">
            <span className="w-3.5 h-3.5 rounded-full bg-gradient-to-b from-zinc-300 to-zinc-500 border border-zinc-600 flex items-center justify-center text-[9px] shadow-sm text-zinc-900 font-extrabold">
              -
            </span>
            <span className="tracking-wide text-zinc-900 drop-shadow-xs">
              SPC PS1 Emulator V0.1 | made with gemini
            </span>
          </div>

          {/* Right Status Badge */}
          <div className="flex items-center gap-2 text-[10px] font-mono">
            <span className={hasBiosLoaded ? 'text-emerald-700 font-bold' : 'text-zinc-600'}>
              {hasBiosLoaded && biosInfo ? biosInfo.name : 'NO BIOS LOADED'}
            </span>
            <span
              className={`px-1.5 py-0.2 rounded text-[9px] uppercase font-bold border ${
                status === 'running'
                  ? 'bg-emerald-700 text-white border-emerald-900'
                  : status === 'paused'
                  ? 'bg-amber-700 text-white border-amber-900'
                  : 'bg-zinc-700 text-zinc-300 border-zinc-900'
              }`}
            >
              {status}
            </span>
          </div>
        </div>

        {/* Retro Blue ZSNES Menu Bar with Dropdown Menus */}
        <ZSNESMenuBar
          status={status}
          mode={mode}
          speedMultiplier={speedMultiplier}
          scanlines={scanlines}
          showRegisters={showRegisters}
          showConsole={showConsole}
          hasBiosLoaded={hasBiosLoaded}
          biosInfo={biosInfo}
          hasDiscLoaded={cdromState.hasDisc}
          discName={cdromState.discInfo?.name}
          ips={ips}
          pc={cpuState.pc}
          onOpenLoadBios={handleOpenLoadBios}
          onUnloadBios={handleUnloadBios}
          onOpenMountDisc={handleOpenMountDisc}
          onEjectDisc={handleEjectDisc}
          onRun={handleRun}
          onPause={handlePause}
          onStep={handleStep}
          onReset={handleReset}
          onModeChange={handleModeChange}
          onSpeedChange={handleSpeedChange}
          onToggleScanlines={() => setScanlines(!scanlines)}
          onToggleRegisters={() => setShowRegisters(!showRegisters)}
          onToggleConsole={() => setShowConsole(!showConsole)}
          onClearLogs={handleClearLogs}
          onDumpStatus={() => emu.dumpStatus()}
        />

        {/* Main Emulator Viewport: Retro Starry Background Canvas */}
        <div className="relative flex-1 min-h-0 w-full bg-[#2c1e54] flex flex-col justify-center items-center overflow-hidden">
          <StarryBackground>
            <div className="flex flex-col items-center justify-center p-2 sm:p-4 w-full h-full max-h-full">
              {/* PS1 CRT Display Monitor */}
              <GpuCanvasView
                gpu={emu.gpu}
                gpuState={gpuState}
                scanlines={scanlines}
                status={status}
                lastError={lastError}
                hasBiosLoaded={hasBiosLoaded}
                onOpenLoadBios={handleOpenLoadBios}
                onOpenMountDisc={handleOpenMountDisc}
                hasDiscLoaded={cdromState.hasDisc}
                discName={cdromState.discInfo?.name}
              />
            </div>
          </StarryBackground>

          {/* Drag & Drop Overlay Notice */}
          {isDragging && (
            <div className="absolute inset-0 bg-blue-950/85 backdrop-blur-xs border-4 border-dashed border-blue-400 flex flex-col items-center justify-center text-white z-40">
              <span className="text-lg font-bold font-mono">Drop 512KB BIOS ROM or Game Disc (.ISO / .BIN)</span>
              <span className="text-xs font-mono text-zinc-300 mt-1">Authentic Sony PS1 dumps automatically mounted</span>
            </div>
          )}
        </div>

        {/* Optional Collapsible Registers View */}
        {showRegisters && (
          <div className="p-2 bg-[#1c1c24] border-t border-zinc-800 shrink-0 max-h-48 overflow-y-auto">
            <CpuRegistersView cpuState={cpuState} ips={ips} isPaused={status === 'paused'} />
          </div>
        )}

        {/* System Console View (Collapsible / Hideable) */}
        {showConsole && (
          <ConsoleView
            logs={logs}
            onClear={handleClearLogs}
            onExecuteCommand={handleExecuteCommand}
            isPaused={status === 'paused'}
            onTogglePause={status === 'running' ? handlePause : handleRun}
            onClose={() => setShowConsole(false)}
          />
        )}
      </div>
    </div>
  );
}
