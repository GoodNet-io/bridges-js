// SPDX-License-Identifier: MIT
/**
 * goodnet-js — round-trip tests for the WASM transport.
 *
 * v0.3 ships the real wiring (alpha): `WasmTransport.create()`
 * instantiates the artefact, calls `_gn_core_create → init →
 * register_runtime → start`, and exposes a `register_plugin` thunk
 * the kernel uses to bind JS handlers as native plugins.
 *
 * The suite drives the alpha against a hand-rolled stub `.wasm`
 * fixture (`tests/fixtures/stub-wasm.ts`) — every C entry point
 * returns `GN_OK` so the boot sequence completes without a real
 * kernel. The production goodnet.wasm path stays valid by
 * exporting the same surface plus a real plugin manager.
 *
 * Tests lock in:
 *
 *   1. `WasmTransport.create({wasm: stubBytes})` resolves without
 *      throwing — the full bootstrap sequence runs to `_gn_core_start`.
 *
 *   2. `GoodnetClient.create({wasm: stubBytes})` wraps the transport
 *      without surfacing a "pending impl" error.
 *
 *   3. The `register_plugin` thunk recognises a synthetic
 *      `js-handler-${msg_id}` name and round-trips a registered JS
 *      callback through the kernel-facing dispatch path.
 *
 *   4. The exported type surface (`GnMessage`, `Propagation`,
 *      `handler(...)`) is still in place — drift breaks the build.
 */

import { describe, it, expect } from 'vitest';
import {
  GoodnetClient,
  WasmTransport,
  Propagation,
  type GnMessage,
  type WasmTransportOptions,
} from '../src/index.js';
import { buildStubWasm } from './fixtures/stub-wasm.js';

describe('WasmTransport', () => {
  it('Create — boots against a stub WASM artefact without throwing', async () => {
    const stub = buildStubWasm();
    const t = await WasmTransport.create({ wasm: stub });
    expect(t).toBeInstanceOf(WasmTransport);
    await t.close();
  });

  it('Create — via `GoodnetClient.create({wasm})` returns a usable client', async () => {
    const stub = buildStubWasm();
    const gn = await GoodnetClient.create({ wasm: stub });
    expect(gn).toBeInstanceOf(GoodnetClient);
    gn.close();
  });

  it('Create — boots with an inline 64-byte Ed25519 identity', async () => {
    const stub = buildStubWasm();
    const identity = new Uint8Array(64);
    identity[0] = 0xab; // arbitrary non-zero so the path is exercised
    const t = await WasmTransport.create({ wasm: stub, identity });
    expect(t).toBeInstanceOf(WasmTransport);
    await t.close();
  });

  it('Create — rejects an identity of the wrong length', async () => {
    const stub = buildStubWasm();
    await expect(
      WasmTransport.create({ wasm: stub, identity: new Uint8Array(32) }),
    ).rejects.toThrow(/identity must be 64 bytes/);
  });

  it('Create — rejects when neither {url} nor {wasm} is supplied', async () => {
    await expect(GoodnetClient.create({})).rejects.toThrow(
      /pass either \{url\}.*or \{wasm\}/,
    );
  });

  it('Create — rejects when both {url} and {wasm} are supplied', async () => {
    await expect(
      GoodnetClient.create({ url: 'ws://x', wasm: buildStubWasm() }),
    ).rejects.toThrow(/exactly one/);
  });

  it('RegisterPlugin — round-trips a `js-handler-${msg_id}` name through the thunk', async () => {
    const stub = buildStubWasm();
    const t = await WasmTransport.create({ wasm: stub });

    let received: GnMessage | null = null;
    t.registerHandler(0x0610, (env) => {
      received = env;
      return Propagation.CONSUMED;
    });

    // Simulate the kernel calling the register_plugin thunk for the
    // synthetic name `js-handler-${msg_id}`. Returns the minted
    // instance handle (a non-zero u32 per sdk/plugin_runtime.h).
    const instance = t.__debugInvokeRegisterPlugin('js-handler-1552');
    expect(instance).toBeGreaterThan(0);

    // Simulate the kernel dispatching a frame to that handler.
    const rc = t.__debugDispatch(
      0x0610,
      99n,
      new TextEncoder().encode('hello'),
    );
    expect(rc).toBe(Propagation.CONSUMED);
    expect(received).not.toBeNull();
    expect(received!.msg_id).toBe(0x0610);
    expect(received!.conn_id).toBe(99n);
    expect(new TextDecoder().decode(received!.payload)).toBe('hello');

    await t.close();
  });

  it('RegisterPlugin — returns 0 (GN_PLUGIN_INSTANCE_INVALID) for an unknown name', async () => {
    const stub = buildStubWasm();
    const t = await WasmTransport.create({ wasm: stub });
    expect(t.__debugInvokeRegisterPlugin('not-a-js-handler')).toBe(0);
    expect(t.__debugInvokeRegisterPlugin('js-handler-9999')).toBe(0); // never registered
    await t.close();
  });

  it('Close — is idempotent and clears the handler table', async () => {
    const stub = buildStubWasm();
    const t = await WasmTransport.create({ wasm: stub });
    t.registerHandler(1, () => Propagation.CONSUMED);
    await t.close();
    await t.close(); // no throw
    // After close, registerHandler refuses further work.
    expect(() => t.registerHandler(2, () => Propagation.CONSUMED)).toThrow(
      /closed/,
    );
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
