// SPDX-License-Identifier: MIT
/**
 * goodnet-js — smoke tests for `GoodnetClient`.
 *
 * Uses a mock WebSocket constructor that captures every outbound
 * frame and lets the test script back responses synchronously. No
 * real WS server stands up; the mock implements just enough of the
 * `WebSocketLike` interface to exercise the request/response
 * round-trip and the notification path.
 */

import { describe, it, expect } from 'vitest';
import { GoodnetClient, GoodnetClientError, type WebSocketLike } from '../src/index.js';

interface OutboundFrame {
  raw: string;
  parsed: { id: string; method: string; params?: Record<string, unknown> };
}

class MockWebSocket implements WebSocketLike {
  readyState = 1;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onclose: WebSocketLike['onclose'] = null;
  readonly outbound: OutboundFrame[] = [];

  constructor(public readonly url: string) {
    // Fire `onopen` on the next microtask so the constructor returns
    // before listeners run — matches browser semantics.
    queueMicrotask(() => this.onopen?.call(this, {}));
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (typeof data !== 'string') {
      throw new Error('mock only accepts string frames');
    }
    const parsed = JSON.parse(data) as { id: string; method: string; params?: Record<string, unknown> };
    this.outbound.push({ raw: data, parsed });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.call(this, {});
  }

  /** Test-side helper: deliver a response frame to the client. */
  deliver(frame: object): void {
    this.onmessage?.call(this, { data: JSON.stringify(frame) });
  }
}

/// Sleep just long enough for queueMicrotask to flush.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('GoodnetClient', () => {
  it('completes the WS handshake', async () => {
    const ws = new MockWebSocket('ws://localhost:9100');
    const client = new GoodnetClient({
      url: 'ws://localhost:9100',
      WebSocket: function (this: void) { return ws; } as never,
    });
    await client.ready();
    expect(ws.readyState).toBe(1);
    client.close();
  });

  it('round-trips a `core.connect` request and resolves with the result', async () => {
    const ws = new MockWebSocket('ws://localhost:9100');
    const client = new GoodnetClient({
      url: 'ws://localhost:9100',
      WebSocket: function (this: void) { return ws; } as never,
    });
    await client.ready();

    const pending = client.connect('tcp://peer.example:9100');
    await flush();
    expect(ws.outbound).toHaveLength(1);
    expect(ws.outbound[0].parsed.method).toBe('core.connect');
    expect(ws.outbound[0].parsed.params).toEqual({ uri: 'tcp://peer.example:9100' });

    const id = ws.outbound[0].parsed.id;
    ws.deliver({
      jsonrpc: '2.0',
      id,
      result: { conn_id: 17, peer_pubkey: 'deadbeef' },
    });

    const result = await pending;
    expect(result).toEqual({ conn_id: 17, peer_pubkey: 'deadbeef' });
    client.close();
  });

  it('rejects with GoodnetClientError on a JSON-RPC error response', async () => {
    const ws = new MockWebSocket('ws://localhost:9100');
    const client = new GoodnetClient({
      url: 'ws://localhost:9100',
      WebSocket: function (this: void) { return ws; } as never,
    });
    await client.ready();

    const pending = client.connect('tcp://nowhere:0');
    await flush();
    const id = ws.outbound[0].parsed.id;
    ws.deliver({
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'not implemented in v0.1 skeleton' },
    });
    await expect(pending).rejects.toThrow(GoodnetClientError);
    await expect(pending).rejects.toMatchObject({ code: -32600 });
    client.close();
  });

  it('encodes payloads as base64 in `core.send`', async () => {
    const ws = new MockWebSocket('ws://localhost:9100');
    const client = new GoodnetClient({
      url: 'ws://localhost:9100',
      WebSocket: function (this: void) { return ws; } as never,
    });
    await client.ready();

    const pending = client.send(7, 0x0610, new Uint8Array([0x68, 0x69])); // "hi"
    await flush();
    const params = ws.outbound[0].parsed.params!;
    expect(params.conn_id).toBe(7);
    expect(params.msg_id_hex).toBe('0x0610');
    expect(params.payload_b64).toBe('aGk='); // base64("hi")

    const id = ws.outbound[0].parsed.id;
    ws.deliver({ jsonrpc: '2.0', id, result: { ok: true } });
    await pending;
    client.close();
  });

  it('routes notifications to subscribe callbacks', async () => {
    const ws = new MockWebSocket('ws://localhost:9100');
    const client = new GoodnetClient({
      url: 'ws://localhost:9100',
      WebSocket: function (this: void) { return ws; } as never,
    });
    await client.ready();

    const received: Uint8Array[] = [];
    const sub = client.subscribe(11, 0x0700, (p) => received.push(p));

    await flush();
    // Server-side notification frame.
    ws.deliver({
      jsonrpc: '2.0',
      method: 'core.notify',
      params: { conn_id: 11, msg_id: 0x0700, payload_b64: 'aGVsbG8=' /* "hello" */ },
    });

    expect(received).toHaveLength(1);
    expect(new TextDecoder().decode(received[0])).toBe('hello');

    sub.unsubscribe();
    ws.deliver({
      jsonrpc: '2.0',
      method: 'core.notify',
      params: { conn_id: 11, msg_id: 0x0700, payload_b64: 'd29ybGQ=' /* "world" */ },
    });
    expect(received).toHaveLength(1);

    client.close();
  });

  it('rejects pending calls when the underlying WS closes', async () => {
    const ws = new MockWebSocket('ws://localhost:9100');
    const client = new GoodnetClient({
      url: 'ws://localhost:9100',
      WebSocket: function (this: void) { return ws; } as never,
    });
    await client.ready();

    const pending = client.connect('tcp://peer:9100');
    await flush();
    ws.close();
    await expect(pending).rejects.toThrow(GoodnetClientError);
  });
});
