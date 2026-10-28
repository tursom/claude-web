export type TerminalStatus = 'running' | 'closing' | 'exited';
export interface TerminalInfo {
  terminalId: string;
  epoch: string;
  cwd: string;
  name: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  createdAt: number;
  exitCode?: number;
  signal?: number;
}
export type TerminalFrame =
  | ({ type: 'terminal.snapshot'; seq: number; screen: string } & TerminalInfo)
  | { type: 'terminal.output'; terminalId: string; epoch: string; seq: number; data: string }
  | { type: 'terminal.resized'; terminalId: string; epoch: string; seq: number; cols: number; rows: number }
  | { type: 'terminal.exited'; terminalId: string; epoch: string; exitCode?: number; signal?: number }
  | { type: 'terminal.list'; cwd: string; terminals: TerminalInfo[] }
  | { type: 'terminal.error'; terminalId: string; code: string; message: string };
export type TerminalListener = (frame: TerminalFrame) => void;
