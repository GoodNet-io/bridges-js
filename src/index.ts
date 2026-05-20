// SPDX-License-Identifier: MIT
/**
 * goodnet-js — JavaScript / TypeScript client for the goodnetd
 * kernel. Two transports share a single `GoodnetClient` surface:
 *
 *   1. **WS thin client** (`{url: 'ws://...'}`). Opens a WebSocket
 *      to a remote `goodnetd` and speaks the JSON-RPC dialect
 *      advertised by `gn.handler.web-api-proxy`. ~10 KB bundle,
 *      needs a daemon.
 *
 *   2. **WASM full kernel** (`{wasm: '/goodnet.wasm'}`). Instantiates
 *      the kernel itself inside the tab and registers JS handlers
 *      as native plugins via the `gn_core_register_runtime` C ABI
 *      (kernel commit 4e3558d, sdk/plugin_runtime.h). No daemon,
 *      browser-as-peer. ~600 KB-1.5 MB bundle. v0.2 ships the
 *      surface; the dynCall wire-up follows when the emscripten
 *      Module exports are pinned — `WasmTransport.create()`
 *      currently throws a documented "pending impl" error.
 *
 * Browser usage:
 * ```ts
 * import { GoodnetClient } from 'goodnet-js';
 * const gn = await GoodnetClient.create({ url: 'ws://localhost:9100' });
 * const { conn_id } = await gn.connect('tcp://peer.example:9100');
 * await gn.send(conn_id, 0x0610, new TextEncoder().encode('hello'));
 * gn.close();
 * ```
 *
 * Node.js usage — the `ws` constructor must be passed explicitly so
 * the package itself stays browser-first (no `ws` dependency in the
 * runtime closure):
 * ```ts
 * import WebSocket from 'ws';
 * const gn = await GoodnetClient.create({ url: '...', WebSocket });
 * ```
 */

import {
  WasmTransport,
  type WasmTransportOptions,
  type GnMessage,
  Propagation,
} from './WasmTransport.js';

export {
  WasmTransport,
  type WasmTransportOptions,
  type GnMessage,
  Propagation,
};

/**
 * Subset of the `WebSocket` interface the client requires. Lines up
 * with both the browser's built-in WebSocket and the npm `ws`
 * package; whichever is in scope works as long as `send`, `close`,
 * the `onmessage` / `onopen` / `onerror` / `onclose` event handlers,
 * and the `readyState` constants are present.
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((this: WebSocketLike, ev: unknown) => void) | null;
  onmessage: ((this: WebSocketLike, ev: { data: string | ArrayBuffer }) => void) | null;
  onerror: ((this: WebSocketLike, ev: unknown) => void) | null;
  onclose: ((this: WebSocketLike, ev: unknown) => void) | null;
}

/** Constructor signature so callers can inject a Node-side `WebSocket`. */
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

/**
 * Options for the WS thin-client transport. Pass either this or a
 * `{wasm}` block — see {@link GoodnetClientOptions}.
 */
export interface GoodnetClientOpts {
  /** URL to dial — `ws://goodnetd-host:9100` or wss equivalent. */
  url: string;
  /**
   * Optional custom WebSocket constructor (e.g. `import WebSocket from 'ws'`).
   * Defaults to the browser's global `WebSocket`.
   */
  WebSocket?: WebSocketCtor;
}

/**
 * Union of every transport-selection knob accepted by
 * {@link GoodnetClient.create}. Exactly one of `url` or `wasm`
 * must be set.
 */
export interface GoodnetClientOptions {
  /** Existing — open a WS thin client against `web_api_proxy`. */
  url?: string;
  /** Inject a custom WebSocket constructor (Node-side, tests). */
  WebSocket?: WebSocketCtor;
  /** New — instantiate a full kernel WASM blob inside the tab. */
  wasm?: string | ArrayBuffer;
  /** Optional 64-byte Ed25519 secret for the WASM-kernel identity. */
  identity?: Uint8Array;
}

export interface ConnectResult {
  conn_id: number;
  peer_pubkey: string;
}

export interface Subscription {
  /** Cancel the subscription. Idempotent. */
  unsubscribe(): void;
}

/**
 * Rejected from every in-flight request when the underlying
 * transport closes before a response arrives.
 */
export class GoodnetClientError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
    this.name = 'GoodnetClientError';
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: {
    msg_id?: number;
    conn_id?: number;
    payload_b64?: string;
  };
}

/**
 * Encode a `Uint8Array` as a base64 string. Browser-side and Node-
 * side share this helper — no third-party `Buffer` dependency in
 * the browser bundle.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  if (typeof btoa === 'function') return btoa(binary);
  // Node.js fallback.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).Buffer.from(bytes).toString('base64');
}

function fromBase64(s: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(s, 'base64'));
}

/**
 * Browser-side wrapper for the goodnetd. Owns either a WS gateway
 * connection (thin client) or a WASM kernel instance (full peer);
 * exposes the same {@link connect}/{@link send}/{@link subscribe}
 * surface to callers regardless of which transport sits underneath.
 *
 * Prefer the async {@link GoodnetClient.create} factory — the WASM
 * path needs `WebAssembly.instantiate` which is asynchronous. The
 * legacy `new GoodnetClient({url, WebSocket})` constructor is kept
 * for the WS path only (and is what the mock-WS test suite uses).
 */
export class GoodnetClient {
  private readonly ws: WebSocketLike | null = null;
  private readonly wasm: WasmTransport | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  // (conn_id, msg_id) → callback list. v0.1 holds at most a few
  // entries per client; no need for a fancier index.
  private readonly subscriptions = new Map<string, Set<(payload: Uint8Array) => void>>();
  private openPromise: Promise<void>;
  private closed = false;

  /**
   * Direct WS constructor (existing v0.1 surface). For the WASM
   * transport use {@link GoodnetClient.create} which is async.
   */
  constructor(opts: GoodnetClientOpts);
  /** @internal — used by {@link GoodnetClient.create} for the WASM path. */
  constructor(opts: { wasm: WasmTransport });
  constructor(opts: GoodnetClientOpts | { wasm: WasmTransport }) {
    if ('wasm' in opts) {
      this.wasm = opts.wasm;
      this.openPromise = Promise.resolve();
      return;
    }
    const wsOpts = opts;
    const Ctor =
      wsOpts.WebSocket ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((globalThis as any).WebSocket as WebSocketCtor | undefined);
    if (!Ctor) {
      throw new GoodnetClientError(
        -1,
        'No WebSocket constructor available. Pass one explicitly when running outside the browser.',
      );
    }
    this.ws = new Ctor(wsOpts.url);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = (ev) =>
        reject(new GoodnetClientError(-2, `WS error: ${String(ev)}`));
    });
    this.ws.onmessage = (ev) => this.handleMessage(ev.data);
    this.ws.onclose = () => this.failPending('WS connection closed');
  }

  /**
   * Async factory — picks the transport implied by `opts`:
   *   - `{url}` → WS thin client (resolves once the handshake is done).
   *   - `{wasm}` → WASM full kernel (resolves once the kernel is up).
   *
   * Throws if both or neither are supplied.
   */
  static async create(opts: GoodnetClientOptions): Promise<GoodnetClient> {
    if (opts.wasm && opts.url) {
      throw new GoodnetClientError(
        -5,
        'GoodnetClient.create: pass exactly one of {url} or {wasm}, not both.',
      );
    }
    if (opts.wasm) {
      const wasmOpts: WasmTransportOptions = { wasm: opts.wasm };
      if (opts.identity) wasmOpts.identity = opts.identity;
      const t = await WasmTransport.create(wasmOpts);
      return new GoodnetClient({ wasm: t });
    }
    if (opts.url) {
      const wsOpts: GoodnetClientOpts = { url: opts.url };
      if (opts.WebSocket) wsOpts.WebSocket = opts.WebSocket;
      const c = new GoodnetClient(wsOpts);
      await c.ready();
      return c;
    }
    throw new GoodnetClientError(
      -6,
      'GoodnetClient.create: pass either {url} (WS thin client) or {wasm} (full kernel in browser).',
    );
  }

  /** Wait until the WS handshake completes (no-op on the WASM path). */
  ready(): Promise<void> {
    return this.openPromise;
  }

  /**
   * Open a goodnet connection to @p uri. Maps to JSON-RPC
   * `core.connect` on the WS path; not yet wired on the WASM path
   * (returns a documented "pending" error there).
   */
  async connect(uri: string): Promise<ConnectResult> {
    if (this.wasm) {
      throw new GoodnetClientError(
        -7,
        'GoodnetClient.connect: not yet implemented on the WASM transport',
      );
    }
    const r = (await this.call('core.connect', { uri })) as ConnectResult;
    return r;
  }

  /**
   * Send a frame on the given gateway-side conn id. Maps to
   * `core.send`. Payload is base64-encoded over the wire.
   */
  async send(conn_id: number, msg_id: number, payload: Uint8Array): Promise<void> {
    if (this.wasm) {
      throw new GoodnetClientError(
        -7,
        'GoodnetClient.send: not yet implemented on the WASM transport',
      );
    }
    await this.call('core.send', {
      conn_id,
      msg_id_hex: '0x' + msg_id.toString(16).padStart(4, '0'),
      payload_b64: toBase64(payload),
    });
  }

  /**
   * Register a callback for frames matching (`conn_id`, `msg_id`).
   * On the WS path this maps to JSON-RPC `core.subscribe` plus a
   * `core.notify` fan-out. On the WASM path you usually want
   * {@link GoodnetClient.handler} instead — it registers a JS
   * function as a kernel plugin and gets zero-copy memory views.
   */
  subscribe(
    conn_id: number,
    msg_id: number,
    cb: (payload: Uint8Array) => void,
  ): Subscription {
    if (this.wasm) {
      throw new GoodnetClientError(
        -7,
        'GoodnetClient.subscribe: not yet implemented on the WASM transport — use handler({msg_id, on_message}) for the kernel-side path.',
      );
    }
    const key = subscriptionKey(conn_id, msg_id);
    let set = this.subscriptions.get(key);
    if (!set) {
      set = new Set();
      this.subscriptions.set(key, set);
      // Fire the v0.1 subscribe request; ignore the server reply for
      // now — v0.2 returns a subscription id we could thread through.
      void this.call('core.subscribe', {
        conn_id,
        msg_id_hex: '0x' + msg_id.toString(16).padStart(4, '0'),
      }).catch(() => {
        /* swallow — v0.1 skeleton returns "not implemented" */
      });
    }
    set.add(cb);
    return {
      unsubscribe: () => {
        const s = this.subscriptions.get(key);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) this.subscriptions.delete(key);
      },
    };
  }

  /**
   * Register a JS function as a kernel-side handler for @p msg_id.
   *
   * On the WASM transport the callback runs as a native plugin —
   * the kernel calls it directly via the C ABI in
   * `sdk/plugin_runtime.h`, the JS side gets a `Uint8Array` view
   * into linear memory (zero copy, valid only during the callback).
   *
   * On the WS transport this falls back to a JSON-RPC subscribe
   * with a `conn_id` of 0 — every connection's traffic for that
   * msg_id is delivered to the callback after a base64 decode. The
   * return value (`Propagation`) is forwarded as a hint; the
   * gateway in v0.1 currently ignores it.
   */
  async handler(opts: {
    msg_id: number;
    on_message: (env: GnMessage) => Propagation;
  }): Promise<void> {
    if (this.wasm) {
      this.wasm.registerHandler(opts.msg_id, opts.on_message);
      return;
    }
    // WS fallback: subscribe with conn_id=0 (wildcard) and adapt
    // base64 notifications into GnMessage envelopes.
    await this.call('core.subscribe', {
      msg_id_hex: '0x' + opts.msg_id.toString(16).padStart(4, '0'),
    }).catch(() => {
      /* swallow — v0.1 skeleton returns "not implemented" */
    });
    const key = subscriptionKey(0, opts.msg_id);
    let set = this.subscriptions.get(key);
    if (!set) {
      set = new Set();
      this.subscriptions.set(key, set);
    }
    set.add((payload) => {
      opts.on_message({
        msg_id: opts.msg_id,
        conn_id: 0n,
        payload,
      });
    });
  }

  /** Close the gateway-side conn id. */
  async disconnect(conn_id: number): Promise<void> {
    if (this.wasm) {
      throw new GoodnetClientError(
        -7,
        'GoodnetClient.disconnect: not yet implemented on the WASM transport',
      );
    }
    await this.call('core.disconnect', { conn_id });
  }

  /** List the handlers registered on the goodnetd. Diagnostic. */
  async listHandlers(): Promise<unknown> {
    if (this.wasm) {
      throw new GoodnetClientError(
        -7,
        'GoodnetClient.listHandlers: not yet implemented on the WASM transport',
      );
    }
    return this.call('core.handlers.list', {});
  }

  /** List the links registered on the goodnetd. Diagnostic. */
  async listLinks(): Promise<unknown> {
    if (this.wasm) {
      throw new GoodnetClientError(
        -7,
        'GoodnetClient.listLinks: not yet implemented on the WASM transport',
      );
    }
    return this.call('core.links.list', {});
  }

  /**
   * Close the underlying transport. After this every call rejects.
   * Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.failPending('client closed');
    }
    if (this.wasm) {
      void this.wasm.close();
    }
  }

  // ── private ──────────────────────────────────────────────────────

  private async call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      throw new GoodnetClientError(-3, 'client closed');
    }
    if (!this.ws) {
      throw new GoodnetClientError(-7, 'WS call on non-WS transport');
    }
    await this.openPromise;
    const id = String(this.nextId++);
    const req: JsonRpcRequest = { jsonrpc: '2.0', method, id, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(req));
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleMessage(data: string | ArrayBuffer): void {
    const text =
      typeof data === 'string' ? data : new TextDecoder().decode(data);
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // ignore malformed frames
    }
    // Notification (no id, has method)
    if ('method' in msg && !('id' in msg)) {
      const params = msg.params;
      if (
        params &&
        typeof params.conn_id === 'number' &&
        typeof params.msg_id === 'number' &&
        typeof params.payload_b64 === 'string'
      ) {
        const bytes = fromBase64(params.payload_b64);
        // Fan out to (conn_id, msg_id) subscribers AND to the
        // wildcard (0, msg_id) handlers registered via handler().
        const exact = subscriptionKey(params.conn_id, params.msg_id);
        const wildcard = subscriptionKey(0, params.msg_id);
        for (const k of [exact, wildcard]) {
          const set = this.subscriptions.get(k);
          if (!set) continue;
          for (const cb of set) {
            try { cb(bytes); } catch { /* user cb threw — ignore */ }
          }
        }
      }
      return;
    }
    // Response — match by id.
    const id = (msg as JsonRpcResponse).id;
    if (typeof id !== 'string') return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    const resp = msg as JsonRpcResponse;
    if (resp.error) {
      pending.reject(new GoodnetClientError(resp.error.code, resp.error.message));
    } else {
      pending.resolve(resp.result);
    }
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) {
      p.reject(new GoodnetClientError(-4, reason));
    }
    this.pending.clear();
  }
}

function subscriptionKey(conn_id: number, msg_id: number): string {
  return `${conn_id}:${msg_id}`;
}
