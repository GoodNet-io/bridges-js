// SPDX-License-Identifier: MIT
/**
 * goodnet-js — browser-first JavaScript client for the goodnetd
 * WS gateway (handler-web-api-proxy).
 *
 * The library wraps a single WebSocket connection to a goodnetd
 * instance and exposes the v0.1 JSON-RPC surface advertised by
 * `gn.handler.web-api-proxy`: connect / send / subscribe / disconnect
 * plus two introspection calls. v0.1 is a thin transport — every
 * call serialises as `{"jsonrpc":"2.0","method":...,"id":...,...}`,
 * the gateway's response is matched by id, and notifications fan
 * out to subscribe callbacks.
 *
 * Browser usage:
 * ```ts
 * import { GoodnetClient } from 'goodnet-js';
 * const gn = new GoodnetClient({ url: 'ws://localhost:9100' });
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
 * const gn = new GoodnetClient({ url: '...', WebSocket });
 * ```
 */

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

export interface GoodnetClientOpts {
  /** URL to dial — `ws://goodnetd-host:9100` or wss equivalent. */
  url: string;
  /**
   * Optional custom WebSocket constructor (e.g. `import WebSocket from 'ws'`).
   * Defaults to the browser's global `WebSocket`.
   */
  WebSocket?: WebSocketCtor;
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
 * Reject every in-flight request with this error when the underlying
 * WS closes before a response arrives.
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
 * Browser-side wrapper for the goodnetd WS gateway. Owns a single
 * WebSocket; serialises requests, demultiplexes responses by id,
 * routes notifications to registered subscribers.
 */
export class GoodnetClient {
  private readonly ws: WebSocketLike;
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  // (conn_id << 32) | msg_id → callback list. v0.1 holds at most
  // a few entries per client; no need for a fancier index.
  private readonly subscriptions = new Map<string, Set<(payload: Uint8Array) => void>>();
  private openPromise: Promise<void>;
  private closed = false;

  constructor(opts: GoodnetClientOpts) {
    const Ctor =
      opts.WebSocket ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((globalThis as any).WebSocket as WebSocketCtor | undefined);
    if (!Ctor) {
      throw new GoodnetClientError(
        -1,
        'No WebSocket constructor available. Pass one explicitly when running outside the browser.',
      );
    }
    this.ws = new Ctor(opts.url);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (ev) => reject(new GoodnetClientError(-2, `WS error: ${String(ev)}`));
    });
    this.ws.onmessage = (ev) => this.handleMessage(ev.data);
    this.ws.onclose = () => this.failPending('WS connection closed');
  }

  /** Wait until the WS handshake completes. */
  ready(): Promise<void> {
    return this.openPromise;
  }

  /**
   * Open a goodnet connection to @p uri through the gateway. Maps to
   * JSON-RPC `core.connect`.
   */
  async connect(uri: string): Promise<ConnectResult> {
    const r = (await this.call('core.connect', { uri })) as ConnectResult;
    return r;
  }

  /**
   * Send a frame on the given gateway-side conn id. Maps to
   * `core.send`. Payload is base64-encoded over the wire.
   */
  async send(conn_id: number, msg_id: number, payload: Uint8Array): Promise<void> {
    await this.call('core.send', {
      conn_id,
      msg_id_hex: '0x' + msg_id.toString(16).padStart(4, '0'),
      payload_b64: toBase64(payload),
    });
  }

  /**
   * Register a callback for frames matching (`conn_id`, `msg_id`).
   * The gateway pushes `core.notify` notifications when a matching
   * envelope arrives; the callback is invoked with the decoded
   * payload bytes.
   */
  subscribe(
    conn_id: number,
    msg_id: number,
    cb: (payload: Uint8Array) => void,
  ): Subscription {
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

  /** Close the gateway-side conn id. */
  async disconnect(conn_id: number): Promise<void> {
    await this.call('core.disconnect', { conn_id });
  }

  /** List the handlers registered on the goodnetd. Diagnostic. */
  async listHandlers(): Promise<unknown> {
    return this.call('core.handlers.list', {});
  }

  /** List the links registered on the goodnetd. Diagnostic. */
  async listLinks(): Promise<unknown> {
    return this.call('core.links.list', {});
  }

  /** Close the underlying WebSocket. After this every call rejects. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ws.close();
    this.failPending('client closed');
  }

  // ── private ──────────────────────────────────────────────────────

  private async call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      throw new GoodnetClientError(-3, 'client closed');
    }
    await this.openPromise;
    const id = String(this.nextId++);
    const req: JsonRpcRequest = { jsonrpc: '2.0', method, id, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(req));
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
        const key = subscriptionKey(params.conn_id, params.msg_id);
        const set = this.subscriptions.get(key);
        if (set) {
          const bytes = fromBase64(params.payload_b64);
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
