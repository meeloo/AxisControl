// Makera Carvera / Z1 — stub driver.
//
// See README.md in this directory before implementing. The important structural
// point: this machine speaks raw TCP or USB serial, not HTTP, so it needs
// WebSerial or a small WebSocket⇄TCP bridge. The interface below is already
// transport-agnostic, so that choice stays inside this file.
//
// Every method throws rather than silently no-opping: a half-implemented driver
// that quietly does nothing is far worse to debug at the machine than one that
// says exactly what is missing.

import type { ConnectionConfig, JogOptions, MachineDriver } from '../../driver.js';
import {
  defaultCapabilities,
  emptyMachineState,
  type Capabilities,
  type DiagnosticSection,
  type FileEntry,
  type LogLine,
  type HeightMapCommands,
  type MachineState,
  type ScanArea,
  type VelocityJogStatus,
} from '../../types.js';

function todo(what: string): never {
  throw new Error(`Carvera driver: ${what} is not implemented yet`);
}

export class CarveraDriver implements MachineDriver {
  readonly id = 'carvera';
  readonly label = 'Makera Carvera / Z1';

  // Start conservative. Panels read this to decide whether to render, so an
  // honest capability set yields a coherent UI even while the driver is a stub.
  readonly capabilities: Capabilities = {
    ...defaultCapabilities(),
    objectModel: false,
    files: false,
    fileWrite: false,
    macros: false,
    workCoordinateSystems: 6,
    coordinateRotation: false,
    surfaceMap: false,
    jobFilePosition: false,
    toolChanger: true,
    prompts: false,
    gcodeRoot: '/sd/gcodes',
    configRoot: null,
    macroRoot: null,
  };

  private stateSubs = new Set<(s: MachineState) => void>();
  private logSubs = new Set<(l: LogLine) => void>();

  async connect(_config: ConnectionConfig): Promise<void> {
    todo('connect (needs WebSerial or a WebSocket⇄TCP bridge — see README.md)');
  }

  async disconnect(): Promise<void> {
    // Safe to call on a never-connected driver.
  }

  onState(cb: (s: MachineState) => void): () => void {
    this.stateSubs.add(cb);
    cb(emptyMachineState());
    return () => this.stateSubs.delete(cb);
  }

  onLog(cb: (l: LogLine) => void): () => void {
    this.logSubs.add(cb);
    return () => this.logSubs.delete(cb);
  }

  async send(_command: string): Promise<void> {
    todo('send');
  }
  async query(_command: string): Promise<string> {
    todo('query');
  }
  async jog(_deltas: Record<string, number>, _opts: JogOptions): Promise<void> {
    todo('jog');
  }
  async moveToMachine(
    _targets: Record<string, number>,
    _opts?: { feedRate?: number },
  ): Promise<void> {
    todo('moveToMachine');
  }
  /**
   * Not `todo()`, unlike everything else here, and not an oversight.
   *
   * `capabilities.velocityJog` is false for this machine, so nothing should be
   * calling these — but the one that would call them is a live jog pad with a
   * thumb on it, and the cost of being wrong is different in each direction.
   * Throwing from the *stop* path on a machine that is somehow moving is the
   * one failure this driver must not have. Reporting "no velocity jogging" is
   * true, costs nothing, and lets the panel hide itself.
   */
  async velocityJog(_speeds: Record<string, number>): Promise<number | null> {
    return null;
  }
  async velocityJogStatus(): Promise<VelocityJogStatus | null> {
    return null;
  }
  async home(_axes?: string[]): Promise<void> {
    todo('home');
  }
  async setWorkZero(_axis: string, _value: number, _wcs?: number): Promise<void> {
    todo('setWorkZero');
  }
  async setWorkOffset(_wcs: number, _axis: string, _machineValue: number): Promise<void> {
    todo('setWorkOffset');
  }
  async selectWcs(_index: number): Promise<void> {
    todo('selectWcs');
  }
  async setRotation(_angle: number, _centreX: number, _centreY: number): Promise<void> {
    todo('setRotation');
  }
  async clearRotation(): Promise<void> {
    todo('clearRotation');
  }
  async reset(): Promise<void> {
    todo('reset');
  }

  async emergencyStop(): Promise<void> {
    todo('emergencyStop');
  }
  async setSpindle(_rpm: number, _direction: 'forward' | 'reverse'): Promise<void> {
    todo('setSpindle');
  }
  // --- Moved off the panels, still to do here ----------------------------
  //
  // Grbl-derived controllers do not take M220 for the feed override — it is a
  // realtime byte outside the G-code stream — so these must not be forwarded
  // as G-code when they are filled in. The capability flags above are false
  // until each one is real, and the panels are hidden meanwhile.

  async setFeedOverride(_percent: number): Promise<void> {
    todo('setFeedOverride');
  }

  async babystep(_axis: string, _delta: number): Promise<void> {
    todo('babystep');
  }

  async selectTool(_tool: number | null): Promise<void> {
    todo('selectTool');
  }

  async changeTool(_slot: number, _action: 'pickup' | 'drop'): Promise<void> {
    todo('changeTool');
  }

  async goToWorkOrigin(_options?: { clearanceZ?: number; includeZ?: boolean }): Promise<void> {
    todo('goToWorkOrigin');
  }

  async startJobAt(_path: string, _byteOffset: number): Promise<void> {
    todo('startJobAt');
  }

  async defineProbeGrid(_area: ScanArea): Promise<void> {
    todo('defineProbeGrid');
  }

  async probeGrid(_probe: number): Promise<void> {
    todo('probeGrid');
  }

  async applyHeightMap(): Promise<void> {
    todo('applyHeightMap');
  }

  async clearHeightMap(): Promise<void> {
    todo('clearHeightMap');
  }

  describeHeightMap(_area: ScanArea, _probe: number | null): HeightMapCommands {
    return { define: '', scan: '', apply: '', clear: '' };
  }

  async stopSpindle(): Promise<void> {
    todo('stopSpindle');
  }
  async listFiles(_dir: string): Promise<FileEntry[]> {
    todo('listFiles');
  }
  async readFile(_path: string): Promise<Uint8Array> {
    todo('readFile');
  }
  async writeFile(_path: string, _data: Uint8Array): Promise<void> {
    todo('writeFile');
  }
  async deleteFile(_path: string): Promise<void> {
    todo('deleteFile');
  }
  async makeDirectory(_path: string): Promise<void> {
    todo('makeDirectory');
  }
  async startJob(_path: string): Promise<void> {
    todo('startJob');
  }
  async pauseJob(): Promise<void> {
    todo('pauseJob');
  }
  async resumeJob(): Promise<void> {
    todo('resumeJob');
  }
  async cancelJob(): Promise<void> {
    todo('cancelJob');
  }
  /** Nothing to report until the transport exists; the panel hides itself. */
  diagnostics(): DiagnosticSection[] {
    return [];
  }

  async runMacro(_path: string): Promise<void> {
    todo('runMacro');
  }
  async answerPrompt(_seq: number, _accept: boolean, _value?: string | number): Promise<void> {
    todo('answerPrompt');
  }
}
