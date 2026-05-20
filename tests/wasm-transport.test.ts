// SPDX-License-Identifier: MIT
/**
 * goodnet-js — surface-stability tests for the WASM transport.
 *
 * v0.2 ships the API surface; the dynCall thunking sits behind a
 * documented "pending impl" guard until the emscripten Module
 * exports are pinned. These tests lock in:
 *
 *   1. `GoodnetClient.create({wasm})` rejects with the documented
 *      "pending" error (so apps that wire against it early get a
 *      clear signal, not a silent stall);
 *
 *   2. The exported type surface — `GnMessage`, `Propagation`,
 *      `handler(...)` — is in place. This is a compile-time check
 *      on the test file; if the surface drifts the import below
 *      starts failing TypeScript and `npm test` no longer compiles.
 */

import { describe, it, expect } from 'vitest';
import {
  GoodnetClient,
  WasmTransport,
  Propagation,
  type GnMessage,
  type WasmTransportOptions,
} from '../src/index.js';

describe('WasmTransport', () => {
  it('CreatePendingImpl — GoodnetClient.create({wasm}) throws the documented "pending" error', async () => {
    await expect(
      GoodnetClient.create({ wasm: '/path/to/goodnet.wasm' }),
    ).rejects.toThrow(/pending Module exports wire-up/);
  });

  it('CreatePendingImpl — WasmTransport.create() directly also throws "pending"', async () => {
    await expect(
      WasmTransport.create({ wasm: '/path/to/goodnet.wasm' }),
    ).rejects.toThrow(/pending Module exports wire-up/);
  });

  it('Create — rejects when neither {url} nor {wasm} is supplied', async () => {
    await expect(GoodnetClient.create({})).rejects.toThrow(
      /pass either \{url\}.*or \{wasm\}/,
    );
  });

  it('Create — rejects when both {url} and {wasm} are supplied', async () => {
    await expect(
      GoodnetClient.create({ url: 'ws://x', wasm: '/y.wasm' }),
    ).rejects.toThrow(/exactly one/);
  });

  it('TypeSurfaceStable — Propagation enum carries the three documented variants', () => {
    expect(Propagation.CONSUMED).toBe(1);
    expect(Propagation.CONTINUE).toBe(2);
    expect(Propagation.PASS_THROUGH).toBe(3);
  });

  it('TypeSurfaceStable — GnMessage / WasmTransportOptions shapes compile', () => {
    // Compile-time shape lock-in: if any field disappears or changes
    // type the build fails. The runtime body just affirms the
    // declared values land where we expect.
    const env: GnMessage = {
      msg_id: 0x0610,
      conn_id: 42n,
      payload: new Uint8Array([1, 2, 3]),
    };
    expect(env.msg_id).toBe(0x0610);
    expect(env.conn_id).toBe(42n);
    expect(env.payload).toBeInstanceOf(Uint8Array);

    const opts: WasmTransportOptions = {
      wasm: '/goodnet.wasm',
      identity: new Uint8Array(64),
    };
    expect(opts.identity?.byteLength).toBe(64);
  });

  it('TypeSurfaceStable — GoodnetClient.handler() exists on the prototype', () => {
    expect(typeof GoodnetClient.prototype.handler).toBe('function');
  });
});
