// SPDX-License-Identifier: MIT
/**
 * goodnet-js — WasmTransport: full GoodNet kernel running as WASM
 * inside the browser tab.
 *
 * Where the WS transport (see `index.ts`) is a thin RPC client
 * against an external `goodnetd` over a WebSocket, `WasmTransport`
 * instantiates the kernel itself in linear memory and registers
 * JS handlers as native plugins via the C ABI declared in
 * `sdk/plugin_runtime.h` (kernel commit 4e3558d).
 *
 * Wire layout for handler dispatch:
 *
 *   1. `WasmTransport.create({wasm})` fetches + instantiates the
 *      emscripten Module, calls `_gn_core_create`, installs an
 *      identity (`_gn_core_install_identity_from_file` — preload
 *      `/identity.bin` into Module.FS), then `_gn_core_init`.
 *
 *   2. We allocate a `gn_plugin_runtime_vtable_t` struct in the
 *      WASM heap (api_size + 4 function pointers — register_plugin,
 *      unregister_plugin, init, shutdown). Each function pointer
 *      is produced by `Module.addFunction(thunk, sig)` so the JS
 *      callbacks become callable from C.
 *
 *   3. `_gn_core_register_runtime(core, "wasm-plugin", vtable, ctx)`
 *      hands the runtime to the kernel. The kernel's PluginManager
 *      then picks up manifest entries whose `runtime:` field is
 *      `"wasm-plugin"`.
 *
 *   4. `registerHandler(msg_id, on_message)` appends a synthetic
 *      entry `{runtime:"wasm-plugin", path:"js://msg_id_N"}` to the
 *      manifest, triggers a rescan, the kernel calls our
 *      `register_plugin` thunk with that entry, we build a
 *      `gn_handler_vtable_t` whose `handle_message` thunk dynCalls
 *      back into JS — passing the `gn_message_t*` so the JS side
 *      can read payload bytes via `Module.HEAPU8.subarray(p, p+n)`.
 *
 * Zero-copy on the hot path: the JS callback receives a `Uint8Array`
 * view into linear memory; no base64, no JSON, no allocation per
 * frame. The view is only valid for the duration of the callback.
 *
 * Pairs with kernel commit 4e3558d (sdk/plugin_runtime.h). This
 * file ships the TypeScript surface; the dynCall thunking sits
 * behind a "pending impl" guard until the emscripten Module
 * exports are pinned (v0.3.x).
 */

/** 64-bit gn_conn_id_t projected into JS as bigint. */
export type GnConnId = bigint;

/**
 * Envelope handed to a JS handler. `payload` is a view into the
 * WASM Module's linear memory and is only valid during the
 * callback — copy if you need to retain the bytes.
 */
export interface GnMessage {
  msg_id: number;
  conn_id: GnConnId;
  payload: Uint8Array;
}

/**
 * Mirrors the kernel's `gn_propagation_t` (handlers/contract.h).
 * Returned from a handler callback to tell the kernel whether the
 * frame was consumed, should fall through to the next handler, or
 * should pass through untouched.
 */
export enum Propagation {
  CONSUMED = 1,
  CONTINUE = 2,
  PASS_THROUGH = 3,
}

export interface WasmTransportOptions {
  /** URL of the `goodnet.wasm` blob or pre-fetched ArrayBuffer. */
  wasm: string | ArrayBuffer;
  /**
   * Optional 64-byte Ed25519 secret. When omitted, the kernel
   * provisions a fresh identity at first run (Phase 5.1 will add
   * an `install_identity_from_memory` C entry; until then the
   * caller must pre-stage `/identity.bin` in `Module.FS`).
   */
  identity?: Uint8Array;
}

type HandlerCallback = (env: GnMessage) => Propagation;

/**
 * Browser-side transport that owns a full kernel instance inside
 * a WASM Module. Constructed via the async {@link WasmTransport.create}
 * factory because emscripten instantiation is asynchronous.
 */
export class WasmTransport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private Module: any = null;
  /** `gn_core_t*` inside linear memory, returned by `_gn_core_create`. */
  private core = 0;
  /** msg_id → JS handler. Looked up by the register_plugin thunk. */
  private readonly handlerTable = new Map<number, HandlerCallback>();
  private closed = false;

  private constructor(private readonly opts: WasmTransportOptions) {}

  /**
   * Fetch + instantiate the WASM kernel, install identity, register
   * the `wasm-plugin` runtime, return a usable transport.
   *
   * v0.2 ships the API surface — the actual emscripten wire-up sits
   * behind a "pending impl" guard until the Module exports
   * (`_gn_core_create`, `_gn_core_register_runtime`, the `addFunction`
   * signature strings) are pinned. Until then this throws.
   */
  static async create(opts: WasmTransportOptions): Promise<WasmTransport> {
    const t = new WasmTransport(opts);
    await t.bootstrap();
    return t;
  }

  /**
   * Register a JS handler for the given message id. Maps to a
   * synthetic manifest entry `{runtime:"wasm-plugin", path:"js://msg_id_${msg_id}"}`
   * which the kernel's PluginManager picks up.
   *
   * Re-registering the same `msg_id` replaces the previous callback.
   */
  registerHandler(msg_id: number, on_message: HandlerCallback): void {
    if (this.closed) {
      throw new Error('WasmTransport: closed');
    }
    this.handlerTable.set(msg_id, on_message);
    // When the dynCall thunks land, this is where we append the
    // synthetic manifest entry and ask the kernel to rescan. For
    // now the table is the only state we hold.
  }

  /**
   * Tear down the kernel instance. Idempotent.
   *
   * Calls `_gn_core_stop` + `_gn_core_destroy` once the Module is
   * wired up; until then it just clears the handler table.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlerTable.clear();
    if (this.Module && this.core) {
      // this.Module._gn_core_stop(this.core);
      // this.Module._gn_core_destroy(this.core);
      this.core = 0;
      this.Module = null;
    }
  }

  // ── private ──────────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    // The thunk wire-up below depends on:
    //   - the emscripten Module factory being exported as a default
    //     from `goodnet.wasm.js` (companion JS glue),
    //   - `addFunction` being available (RESERVED_FUNCTION_POINTERS or
    //     `ALLOW_TABLE_GROWTH`),
    //   - the C entry points `_gn_core_create`, `_gn_core_init`,
    //     `_gn_core_install_identity_from_file`,
    //     `_gn_core_register_runtime`, `_gn_core_stop`, `_gn_core_destroy`
    //     being in `EXPORTED_FUNCTIONS`.
    //
    // Once these are pinned the body below becomes:
    //
    //   const factory = (await import(/* @vite-ignore */ String(this.opts.wasm))).default;
    //   this.Module = await factory({ /* preloads, env, ... */ });
    //   const outCore = this.Module._malloc(4);
    //   this.Module._gn_core_create(outCore);
    //   this.core = this.Module.HEAPU32[outCore >> 2];
    //   this.Module._free(outCore);
    //   // install identity from /identity.bin
    //   this.Module._gn_core_install_identity_from_file(this.core, identityPathPtr);
    //   this.Module._gn_core_init(this.core);
    //   // build vtable
    //   const reg   = this.Module.addFunction(this.thunkRegister.bind(this),   'iiiii');
    //   const unreg = this.Module.addFunction(this.thunkUnregister.bind(this), 'ii');
    //   const init  = this.Module.addFunction(this.thunkInit.bind(this),       'i');
    //   const stop  = this.Module.addFunction(this.thunkShutdown.bind(this),   'i');
    //   const vtable = this.Module._malloc(5 * 4);
    //   const u32 = this.Module.HEAPU32;
    //   u32[(vtable >> 2) + 0] = 5 * 4;     // api_size
    //   u32[(vtable >> 2) + 1] = reg;
    //   u32[(vtable >> 2) + 2] = unreg;
    //   u32[(vtable >> 2) + 3] = init;
    //   u32[(vtable >> 2) + 4] = stop;
    //   const namePtr = this.Module.stringToNewUTF8('wasm-plugin');
    //   this.Module._gn_core_register_runtime(this.core, namePtr, vtable, 0);
    //
    // Until that contract is pinned (the wasm artefact + glue need
    // to ship from the kernel build), refuse to mislead callers.
    void this.opts;
    throw new Error(
      'WasmTransport: pending Module exports wire-up — kernel commit ' +
        '4e3558d landed the C ABI (sdk/plugin_runtime.h), JS thunking ' +
        'is the next step. Use the WS transport for now ({url: ...}).',
    );
  }
}
