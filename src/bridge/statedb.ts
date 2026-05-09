import { execSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';

function getStateDbPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  } else if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  } else {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  }
}

const STATE_DB_PATH = getStateDbPath();

function queryDb(sql: string): string {
  try {
    return execSync(`sqlite3 "${STATE_DB_PATH}" "${sql}"`, {
      encoding: 'utf-8',
      timeout: 5000
    }).trim();
  } catch {
    return '';
  }
}

export function getApiKey(): string {
  const raw = queryDb("SELECT value FROM ItemTable WHERE key='antigravityAuthStatus';");
  if (!raw) return '';
  try { return JSON.parse(raw).apiKey || ''; } catch { return ''; }
}

export function getUserInfo(): { name: string; email: string; apiKey: string } {
  const raw = queryDb("SELECT value FROM ItemTable WHERE key='antigravityAuthStatus';");
  if (!raw) return { name: '', email: '', apiKey: '' };
  try {
    const data = JSON.parse(raw);
    return { name: data.name || '', email: data.email || '', apiKey: data.apiKey || '' };
  } catch { return { name: '', email: '', apiKey: '' }; }
}
