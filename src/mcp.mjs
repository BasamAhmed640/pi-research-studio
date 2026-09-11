import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Local stdio transport for Visual Explainer's official MCP interface. No
// global MCP configuration, HTTP listener, extra model, or shared environment.
export class LocalMcp {
  constructor(command, args, options = {}) {
    this.pending = new Map(); this.serial = 0; this.closed = false;
    this.child = spawn(command, args, { ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.finished = new Promise(resolve => this.child.once('close', resolve));
    this.errors = '';
    this.child.stderr.on('data', data => { this.errors = (this.errors + data).slice(-2000); });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    this.child.once('error', error => this.fail(error));
    this.child.once('exit', code => this.fail(new Error(`Visual Explainer stopped (${code}). ${this.errors}`)));
    this.child.stdin.on('error', error => this.fail(error));
  }
  fail(error) { this.closed = true; for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  send(message) { if (this.closed) throw new Error('Visual Explainer is closed. Reopen Studio.'); this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Cancelled.'));
      const id = ++this.serial;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const finish = fn => value => { cleanup(); fn(value); };
      const abort = () => { try { this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'User cancelled' } }); } catch {} finish(reject)(new Error('Cancelled.')); };
      const timer = setTimeout(() => finish(reject)(new Error('Visual Explainer did not respond within 30 seconds.')), 30000);
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) { finish(reject)(error); }
    });
  }
  async initialize() {
    await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pi-research-studio', version: '0.1.0' } });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return (await this.request('tools/list')).tools;
  }
  async close() {
    this.fail(new Error('Studio closed.')); this.lines.close(); this.child.stdin.end();
    if (this.child.exitCode === null) this.child.kill();
    await this.finished;
  }
}
