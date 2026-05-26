// SPDX-License-Identifier: MIT
/**
 * goodnet-js transport tests.
 *
 * WsTransport: mock-WebSocket smoke — verifies JSON-RPC serialisation,
 * connect() bigint cast, on() subscribe+notify, close() pending rejection.
 *
 * WasmTransport: stub smoke — verifies on()/unsubscribe contract and
 * that unimplemented methods throw WasmTransportError.
 */

import { describe, it, expect } from 'vitest';
import {
    WsTransport,
    WsTransportError,
    type WsTransportWebSocketCtor,
    WasmTransport,
    WasmTransportError,
    Goodnet,
} from '../src/index.js';

// ── WsTransport mock ──────────────────────────────────────────────────────

interface Frame {
    raw: string;
    parsed: { id: string; method: string; params?: Record<string, unknown> };
}

class MockSocket {
    readyState = 1;
    onopen:    ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror:   ((ev: unknown) => void) | null = null;
    onclose:   ((ev: unknown) => void) | null = null;
    readonly frames: Frame[] = [];

    constructor(public readonly url: string) {
        queueMicrotask(() => this.onopen?.({}));
    }

    send(data: string): void {
        const parsed = JSON.parse(data) as Frame['parsed'];
        this.frames.push({ raw: data, parsed });
    }

    close(): void {
        this.readyState = 3;
        this.onclose?.({});
    }

    deliver(frame: object): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }
}

function makeMockCtor(socket: MockSocket): WsTransportWebSocketCtor {
    return function () { return socket; } as unknown as WsTransportWebSocketCtor;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ── WsTransport tests ─────────────────────────────────────────────────────

describe('WsTransport', () => {
    it('factory resolves once WS opens', async () => {
        const sock = new MockSocket('ws://localhost:9100');
        const t = await WsTransport.connect('ws://localhost:9100', makeMockCtor(sock));
        expect(t).toBeInstanceOf(WsTransport);
        t.close();
    });

    it('connect() round-trips core.connect, returns conn_id as bigint', async () => {
        const sock = new MockSocket('ws://x');
        const t = await WsTransport.connect('ws://x', makeMockCtor(sock));

        const pending = t.connect('tcp://peer:9100');
        await flush();
        expect(sock.frames[0].parsed.method).toBe('core.connect');
        expect(sock.frames[0].parsed.params).toEqual({ uri: 'tcp://peer:9100' });

        sock.deliver({ jsonrpc: '2.0', id: sock.frames[0].parsed.id,
                       result: { conn_id: 42, peer_pubkey: 'deadbeef' } });
        const r = await pending;
        expect(r.conn_id).toBe(42n);
        expect(r.peer_pubkey).toBe('deadbeef');
        t.close();
    });

    it('send() encodes payload as base64', async () => {
        const sock = new MockSocket('ws://x');
        const t = await WsTransport.connect('ws://x', makeMockCtor(sock));

        const p = t.send(7n, 0x0700, new Uint8Array([0x68, 0x69])); // "hi"
        await flush();
        const params = sock.frames[0].parsed.params!;
        expect(params.conn_id).toBe(7);
        expect(params.msg_id_hex).toBe('0x0700');
        expect(params.payload_b64).toBe('aGk=');

        sock.deliver({ jsonrpc: '2.0', id: sock.frames[0].parsed.id, result: {} });
        await p;
        t.close();
    });

    it('on() routes core.notify notifications to handler', async () => {
        const sock = new MockSocket('ws://x');
        const t = await WsTransport.connect('ws://x', makeMockCtor(sock));

        const received: { payload: Uint8Array; conn_id: bigint }[] = [];
        const sub = t.on(0x0700, (payload, conn_id) => received.push({ payload, conn_id }));

        await flush();
        sock.deliver({
            jsonrpc: '2.0', method: 'core.notify',
            params: { conn_id: 11, msg_id: 0x0700, payload_b64: 'aGVsbG8=' },
        });
        expect(received).toHaveLength(1);
        expect(new TextDecoder().decode(received[0].payload)).toBe('hello');
        expect(received[0].conn_id).toBe(11n);

        sub.unsubscribe();
        sock.deliver({
            jsonrpc: '2.0', method: 'core.notify',
            params: { conn_id: 11, msg_id: 0x0700, payload_b64: 'd29ybGQ=' },
        });
        expect(received).toHaveLength(1); // not delivered after unsubscribe
        t.close();
    });

    it('rejects with WsTransportError on JSON-RPC error response', async () => {
        const sock = new MockSocket('ws://x');
        const t = await WsTransport.connect('ws://x', makeMockCtor(sock));

        const p = t.connect('tcp://nowhere:0');
        await flush();
        sock.deliver({ jsonrpc: '2.0', id: sock.frames[0].parsed.id,
                       error: { code: -32600, message: 'not implemented' } });
        await expect(p).rejects.toBeInstanceOf(WsTransportError);
        t.close();
    });

    it('rejects pending calls when WS closes', async () => {
        const sock = new MockSocket('ws://x');
        const t = await WsTransport.connect('ws://x', makeMockCtor(sock));
        const p = t.connect('tcp://x:9100');
        await flush();
        sock.close();
        await expect(p).rejects.toBeInstanceOf(WsTransportError);
    });
});

// ── WasmTransport tests ───────────────────────────────────────────────────

describe('WasmTransport', () => {
    it('create() resolves without throwing', async () => {
        const t = await WasmTransport.create({ wasm: new Uint8Array(0) });
        expect(t).toBeInstanceOf(WasmTransport);
        t.close();
    });

    it('on() / unsubscribe / __debugDispatch round-trip', async () => {
        const t = await WasmTransport.create({ wasm: new Uint8Array(0) });
        const got: { p: Uint8Array; c: bigint }[] = [];
        const sub = t.on(0x0700, (p, c) => got.push({ p, c }));

        const payload = new Uint8Array([1, 2, 3]);
        expect(t.__debugDispatch(0x0700, 5n, payload)).toBe(true);
        expect(got).toHaveLength(1);
        expect(got[0].c).toBe(5n);

        sub.unsubscribe();
        expect(t.__debugDispatch(0x0700, 5n, payload)).toBe(false);
        t.close();
    });

    it('connect() throws WasmTransportError until kernel is wired', async () => {
        const t = await WasmTransport.create({ wasm: new Uint8Array(0) });
        await expect(t.connect('tcp://x:9100')).rejects.toBeInstanceOf(WasmTransportError);
        t.close();
    });

    it('send() throws WasmTransportError until kernel is wired', async () => {
        const t = await WasmTransport.create({ wasm: new Uint8Array(0) });
        await expect(t.send(1n, 0x0700, new Uint8Array(0))).rejects.toBeInstanceOf(WasmTransportError);
        t.close();
    });
});

// ── Goodnet.create() factory ──────────────────────────────────────────────

describe('Goodnet.create', () => {
    it('{ url } returns a WsTransport', async () => {
        const sock = new MockSocket('ws://x');
        const t = await Goodnet.create({ url: 'ws://x', WebSocket: makeMockCtor(sock) });
        expect(t).toBeInstanceOf(WsTransport);
        t.close();
    });

    it('{ wasm } returns a WasmTransport', async () => {
        const t = await Goodnet.create({ wasm: new Uint8Array(0) });
        expect(t).toBeInstanceOf(WasmTransport);
        t.close();
    });
});
