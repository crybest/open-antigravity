import { execSync } from 'child_process';
import { existsSync } from 'fs';

export interface LanguageServerInfo {
  pid: number;
  port: number;
  csrf: string;
  workspace?: string;
}

let _cachedServers: LanguageServerInfo[] = [];
let _cacheTime = 0;
const CACHE_TTL_MS = 3000;

/**
 * Decode Antigravity's workspace_id back to a real file:// URI.
 * Antigravity encodes workspace paths by replacing BOTH `/` and `-` with `_`.
 *
 * Windows: paths look like `file_d_3A_workspace_test` (lowercase drive letter,
 *          colon dropped). We restore as `file:///D:/3A/workspace/test`.
 * Unix:    paths look like `file__home_user_proj`. We restore via existsSync
 *          probing because `_` is ambiguous between `/` and `-`.
 */
function decodeWorkspaceId(wsId: string): string | undefined {
  if (!wsId.startsWith('file_')) return wsId;

  const encoded = wsId.slice(5);
  const parts = encoded.split('_');

  if (process.platform === 'win32') {
    // First non-empty part is the drive letter (lowercase, no colon).
    let i = 0;
    while (i < parts.length && parts[i] === '') i++;
    if (i >= parts.length || !/^[a-z]$/i.test(parts[i])) return undefined;
    const drive = parts[i].toUpperCase() + ':/';
    let resolvedPath = drive;
    i++;

    while (i < parts.length) {
      let found = false;
      for (let len = 1; len <= parts.length - i; len++) {
        const subparts = parts.slice(i, i + len);
        const candidates: string[] = len === 1
          ? [subparts[0]]
          : [subparts.join('-'), subparts.join('_')];
        for (const candidate of candidates) {
          const testPath = resolvedPath + candidate;
          if (existsSync(testPath)) {
            resolvedPath = testPath + '/';
            i += len;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        resolvedPath += parts.slice(i).join('/');
        break;
      }
    }
    return 'file:///' + resolvedPath.replace(/\/$/, '');
  }

  // Unix
  let resolvedPath = '/';
  let i = 0;

  while (i < parts.length) {
    let found = false;
    for (let len = 1; len <= parts.length - i; len++) {
      const subparts = parts.slice(i, i + len);
      const candidates: string[] = [];
      if (len === 1) {
        candidates.push(subparts[0]);
      } else {
        candidates.push(subparts.join('-'));
        candidates.push(subparts.join('_'));
      }
      for (const candidate of candidates) {
        const testPath = resolvedPath + candidate;
        if (existsSync(testPath)) {
          resolvedPath = testPath + '/';
          i += len;
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      resolvedPath += parts.slice(i).join('/');
      break;
    }
  }

  return 'file://' + resolvedPath.replace(/\/$/, '');
}

/**
 * Discover all running Antigravity language_server instances.
 */
export function discoverLanguageServers(): LanguageServerInfo[] {
  if (Date.now() - _cacheTime < CACHE_TTL_MS && _cachedServers.length > 0) {
    return _cachedServers;
  }

  const servers: LanguageServerInfo[] = [];

  try {
    let psLines: string[] = [];
    let netstatOrLsofOutput = '';

    if (process.platform === 'win32') {
      try {
        const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*language_server*' -and $_.CommandLine -like '*--csrf_token*' } | Select-Object ProcessId, CommandLine | ConvertTo-Json"`;
        const psOutput = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
        if (psOutput) {
          const list = JSON.parse(psOutput);
          const processes = Array.isArray(list) ? list : [list];
          for (const p of processes) {
             if (p.ProcessId && p.CommandLine) {
                 psLines.push(`${p.ProcessId} ${p.CommandLine}`);
             }
          }
        }
      } catch {}
      try {
        netstatOrLsofOutput = execSync('netstat -ano', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
      } catch {}
    } else {
      try {
        const psOutput = execSync('ps aux', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
        psLines = psOutput.split('\n').filter(l => l.includes('language_server') && l.includes('--csrf_token'));
      } catch {}
      try {
        netstatOrLsofOutput = execSync('lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
      } catch {}
    }

    for (const line of psLines) {
      let pid = 0;
      let csrf = '';

      if (process.platform === 'win32') {
        const parts = line.split(' ');
        pid = parseInt(parts[0]);
        const csrfMatch = line.match(/--csrf_token[=\s]+(\S+)/);
        if (csrfMatch) csrf = csrfMatch[1].replace(/["']/g, '');
      } else {
        const pidMatch = line.match(/^\S+\s+(\d+)/);
        const csrfMatch = line.match(/--csrf_token[=\s]+(\S+)/);
        if (pidMatch && csrfMatch) {
          pid = parseInt(pidMatch[1]);
          csrf = csrfMatch[1];
        }
      }

      if (!pid || !csrf) continue;

      let port = 0;
      if (process.platform === 'win32') {
        const netstatRegex = new RegExp(`TCP\\s+\\S+:(\\d+)\\s+\\S+\\s+LISTENING\\s+${pid}\\b`, 'm');
        const portMatch = netstatOrLsofOutput.match(netstatRegex);
        if (portMatch) port = parseInt(portMatch[1]);
      } else {
        const pidRegex = new RegExp(`^language_\\S*\\s+${pid}\\s+.*:(\\d{4,5})\\s+\\(LISTEN\\)`, 'm');
        const portMatch = netstatOrLsofOutput.match(pidRegex);
        if (portMatch) port = parseInt(portMatch[1]);
      }
      
      if (port === 0) continue;

      const wsMatch = line.match(/--workspace_id[=\s]+(\S+)/);
      let workspace = undefined;
      if (wsMatch) {
        workspace = decodeWorkspaceId(wsMatch[1].replace(/["']/g, ''));
      }

      servers.push({ pid, port, csrf, workspace });
    }
  } catch {}

  if (servers.length !== _cachedServers.length || servers.some((s, i) => s.port !== _cachedServers[i]?.port)) {
    console.log(`🔎 Discovered ${servers.length} server(s): ${servers.map(s => `port=${s.port} ws="${s.workspace ?? '<no-workspace>'}"`).join(' | ')}`);
  }

  _cachedServers = servers;
  _cacheTime = Date.now();
  return servers;
}

/**
 * Get a language_server for the given workspace.
 *
 * Antigravity runs multiple language_server processes:
 *   - A global instance (no --workspace_id) that handles cascade/gRPC API calls
 *   - Per-workspace instances (with --workspace_id) for file indexing/LSP only
 *
 * The cascade gRPC API (StartCascade, SendUserCascadeMessage, etc.) is served
 * by the GLOBAL no-workspace process. Per-workspace processes will reset our
 * connections (ECONNRESET / TLS failure). So we always prefer the no-workspace
 * one for cascade calls — workspace context is passed via `workspaceUris`
 * on each call, not by routing to a specific server.
 */
export function getLanguageServer(workspacePath?: string): LanguageServerInfo | null {
  const servers = discoverLanguageServers();
  if (servers.length === 0) return null;

  if (workspacePath) {
    const exact = servers.find(s => s.workspace === workspacePath);
    if (exact) return exact;

    const partial = servers.find(s =>
      s.workspace?.includes(workspacePath) || workspacePath.includes(s.workspace || '\0')
    );
    if (partial) return partial;
  }

  // Prefer the global (no-workspace) server — it's the one that serves cascade gRPC.
  const global = servers.find(s => !s.workspace);
  return global ?? servers[0];
}
