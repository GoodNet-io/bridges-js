// SPDX-License-Identifier: MIT
import type { GoodnetTransport, MessageHandler, Subscription, ConnectResult } from './transport.js';

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

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    if (typeof btoa === 'function') return btoa(binary);
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

/** Minimal WebSocket surface WsTransport depends on. */
interface SocketLike {
    readyState: number;
    send(data: string | ArrayBuffer | Uint8Array): void;
    close(code?: number, reason?: string): void;
    onopen: ((this: unknown, ev: unknown) => void) | null;
    onmessage: ((this: unknown, ev: { data: string | ArrayBuffer }) => void) | null;
    onerror: ((this: unknown, ev: unknown) => void) | null;
    onclose: ((this: unknown, ev: unknown) => void) | null;
}

/** Constructor for injecting a Node-side or mock WebSocket into WsTransport. */
export type WsTransportWebSocketCtor = new (url: string, protocols?: string | string[]) => SocketLike;

export class WsTransportError extends Error {
    constructor(public readonly code: number, message: string) {
        super(message);
        this.name = 'WsTransportError';
    }
}

/**
 * Thin-client transport: JSON-RPC over WebSocket against goodnetd's
 * `web_api_proxy` handler. Implements `GoodnetTransport`.
 *
 * Use the async `WsTransport.connect(url)` factory — it resolves once
 * the WS handshake completes.
 */
export class WsTransport implements GoodnetTransport {
    private readonly ws: SocketLike;
    private readonly pending = new Map<string, PendingCall>();
    private readonly subscriptions = new Map<number, Set<MessageHandler>>();
    private reqId = 0;
    private closed = false;

    private constructor(url: string, Ctor: WsTransportWebSocketCtor) {
        this.ws = new Ctor(url);
        this.ws.onmessage = (ev) => this.handleMessage(ev.data);
        this.ws.onclose = () => this.failPending('WS connection closed');
    }

    static connect(
        url: string,
        WebSocketCtor?: WsTransportWebSocketCtor,
    ): Promise<WsTransport> {
        const Ctor =
            WebSocketCtor ??
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ((globalThis as any).WebSocket as WsTransportWebSocketCtor | undefined);
        if (!Ctor) {
            return Promise.reject(
                new WsTransportError(
                    -1,
                    'No WebSocket constructor available. Pass one explicitly when running outside the browser.',
                ),
            );
        }
        const t = new WsTransport(url, Ctor);
        return new Promise((resolve, reject) => {
            t.ws.onopen = () => resolve(t);
            t.ws.onerror = () =>
                reject(new WsTransportError(-2, `WsTransport: connect failed to ${url}`));
        });
    }

    on(msg_id: number, handler: MessageHandler): Subscription {
        let set = this.subscriptions.get(msg_id);
        if (!set) {
            set = new Set();
            this.subscriptions.set(msg_id, set);
            void this.rpc('core.subscribe', {
                msg_id_hex: '0x' + msg_id.toString(16).padStart(4, '0'),
            }).catch(() => { /* v0.1 skeleton may return "not implemented" */ });
        }
        set.add(handler);
        return {
            unsubscribe: () => {
                const s = this.subscriptions.get(msg_id);
                if (!s) return;
                s.delete(handler);
                if (s.size === 0) this.subscriptions.delete(msg_id);
            },
        };
    }

    async send(conn_id: bigint, msg_id: number, payload: Uint8Array): Promise<void> {
        await this.rpc('core.send', {
            conn_id: Number(conn_id),
            msg_id_hex: '0x' + msg_id.toString(16).padStart(4, '0'),
            payload_b64: toBase64(payload),
        });
    }

    async connect(uri: string): Promise<ConnectResult> {
        const r = await this.rpc('core.connect', { uri }) as { conn_id: number; peer_pubkey: string };
        return { conn_id: BigInt(r.conn_id), peer_pubkey: r.peer_pubkey };
    }

    async disconnect(conn_id: bigint): Promise<void> {
        await this.rpc('core.disconnect', { conn_id: Number(conn_id) });
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.ws.close();
        this.failPending('transport closed');
    }

    private async rpc(method: string, params: unknown): Promise<unknown> {
        if (this.closed) throw new WsTransportError(-3, 'transport closed');
        const id = String(this.reqId++);
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
            return;
        }

        if ('method' in msg && !('id' in msg)) {
            const params = msg.params;
            if (
                params &&
                typeof params.msg_id === 'number' &&
                typeof params.payload_b64 === 'string'
            ) {
                const connId =
                    typeof params.conn_id === 'number'
                        ? BigInt(params.conn_id)
                        : 0n;
                const bytes = fromBase64(params.payload_b64);
                const set = this.subscriptions.get(params.msg_id);
                if (set) {
                    for (const handler of set) {
                        try { handler(bytes, connId); } catch { /* user cb threw */ }
                    }
                }
            }
            return;
        }

        const id = (msg as JsonRpcResponse).id;
        if (typeof id !== 'string') return;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        const resp = msg as JsonRpcResponse;
        if (resp.error) {
            p.reject(new WsTransportError(resp.error.code, resp.error.message));
        } else {
            p.resolve(resp.result);
        }
    }

    private failPending(reason: string): void {
        for (const [, p] of this.pending) {
            p.reject(new WsTransportError(-4, reason));
        }
        this.pending.clear();
    }
}
