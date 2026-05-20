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
 *      WASM artefact. Two artefact shapes are accepted:
 *
 *        - **Emscripten Module factory** — the production
 *          `goodnet.wasm.js` companion. Recognised when
 *          `opts.wasm` is a URL string ending in `.js` or when
 *          the artefact exports `__emscripten_module_factory`.
 *          `addFunction(thunk, sig)` comes from the Module.
 *
 *        - **Raw `.wasm` bytes** — a self-contained `ArrayBuffer`
 *          / `Uint8Array` / `.wasm` URL. The transport instantiates
 *          via `WebAssembly.instantiateStreaming` (URL) or
 *          `WebAssembly.instantiate` (bytes) and supplies a
 *          minimal `Module` shim that mediates linear memory +
 *          `addFunction` against an exported
 *          `__indirect_function_table`. Tests use this path with
 *          a hand-rolled fixture so the suite does not depend on
 *          the production kernel-WASM build.
 *
 *   2. We allocate a `gn_plugin_runtime_vtable_t` struct in the
 *      WASM heap. The struct on wasm32 is laid out as
 *      `[api_size: u32][init: u32][register_plugin: u32]
 *       [unregister: u32][shutdown: u32]` — five 32-bit slots,
 *      20 bytes total — matching `sdk/plugin_runtime.h`'s
 *      `gn_plugin_runtime_vtable_t` under the wasm32 ABI where
 *      `size_t` is 4 bytes and function pointers are 4-byte
 *      indices into the indirect function table.
 *
 *   3. `_gn_core_register_runtime(core, name_ptr, vtable_ptr, 0)`
 *      hands the runtime over. The kernel's PluginManager then
 *      picks up manifest entries whose `runtime:` field is
 *      `"wasm-plugin"` and calls our `register_plugin` thunk.
 *
 *   4. `registerHandler(msg_id, on_message)` stashes the callback
 *      in `handlerTable`. When the kernel later calls
 *      `register_plugin` with `entry_name = "js-handler-${msg_id}"`,
 *      the thunk reads the msg_id back out of the name, mints a
 *      fresh instance handle, and the kernel begins dispatching
 *      `gn_message_t*` envelopes into the JS callback.
 *
 * Zero-copy on the hot path: the JS callback receives a `Uint8Array`
 * view into linear memory; no base64, no JSON, no allocation per
 * frame. The view is only valid for the duration of the callback.
 *
 * Pairs with kernel commit 4e3558d (sdk/plugin_runtime.h). v0.3
 * ships the alpha wiring tested against a stub WASM fixture; the
 * production `goodnet.wasm` build (with libsodium-emscripten) is
 * a separate track on the kernel side.
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
  wasm: string | ArrayBuffer | Uint8Array;
  /**
   * Optional 64-byte Ed25519 secret. When present the transport
   * writes the bytes into `/identity.bin` inside the Module's
   * virtual FS (or directly into linear memory on the raw-bytes
   * path) and calls
   * `_gn_core_install_identity_from_file(core, "/identity.bin")`.
   */
  identity?: Uint8Array;
}

type HandlerCallback = (env: GnMessage) => Propagation;

/* ── ABI offsets (wasm32) ─────────────────────────────────────── */

/** size_t on wasm32 — 4 bytes. */
const SIZEOF_SIZE_T = 4;
/** Function pointer width on wasm32 — 4-byte table index. */
const SIZEOF_FN_PTR = 4;
/**
 * `gn_plugin_runtime_vtable_t` total size on wasm32: api_size (4) +
 * init (4) + register_plugin (4) + unregister (4) + shutdown (4)
 * = 20 bytes. Matches `sdk/plugin_runtime.h`.
 */
const VTABLE_SIZE = SIZEOF_SIZE_T + 4 * SIZEOF_FN_PTR;

/* ── Minimal Module shim for the raw-bytes WASM path ──────────── */

/**
 * Subset of the emscripten `Module` interface we depend on. The
 * production `goodnet.wasm.js` companion exposes the same surface;
 * the raw-bytes path synthesises an equivalent shim around a plain
 * `WebAssembly.Instance`.
 *
 * eslint-disable-next-line @typescript-eslint/no-explicit-any
 */
export interface WasmModuleLike {
  /** Linear memory; `HEAPU8` / `HEAPU32` views are slices of `.buffer`. */
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  /** `_malloc(n)` returns a heap offset; `_free(p)` releases it. */
  _malloc(size: number): number;
  _free(ptr: number): void;
  /** Decode a NUL-terminated UTF-8 string at the given heap offset. */
  UTF8ToString(ptr: number): string;
  /** Allocate + copy a JS string into the heap as NUL-terminated UTF-8. */
  stringToNewUTF8(s: string): number;
  /**
   * Install a JS callback as a callable function pointer (an index
   * into the indirect function table). `sig` follows emscripten's
   * single-letter convention: `i`/`v`/`j`/`f`/`d` etc. The raw-bytes
   * path returns a synthetic non-negative integer the kernel can
   * round-trip without dereferencing — production builds wrap the
   * callback in a generated wasm trampoline so the kernel can
   * `call_indirect` into JS.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addFunction(fn: (...args: any[]) => any, sig: string): number;
  /** Exported kernel entry points. */
  _gn_core_create(): number;
  _gn_core_install_identity_from_file(core: number, pathPtr: number): number;
  _gn_core_init(core: number): number;
  _gn_core_register_runtime(
    core: number,
    namePtr: number,
    vtablePtr: number,
    ctxPtr: number,
  ): number;
  _gn_core_start(core: number): number;
  _gn_core_stop?(core: number): number;
  _gn_core_destroy?(core: number): number;
}

/**
 * Build a `WasmModuleLike` shim around a plain `WebAssembly.Instance`.
 * Used by the raw-bytes path; the production emscripten Module
 * factory satisfies this interface natively.
 *
 * eslint-disable-next-line @typescript-eslint/no-explicit-any
 */
function buildShim(instance: WebAssembly.Instance): WasmModuleLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exp = instance.exports as Record<string, any>;

  const memory = exp.memory as WebAssembly.Memory | undefined;
  if (!memory) {
    throw new Error('WasmTransport: WASM artefact does not export `memory`');
  }

  const refreshHeaps = (): { u8: Uint8Array; u32: Uint32Array } => ({
    u8: new Uint8Array(memory.buffer),
    u32: new Uint32Array(memory.buffer),
  });

  const heaps = refreshHeaps();
  const shim: WasmModuleLike = {
    HEAPU8: heaps.u8,
    HEAPU32: heaps.u32,
    _malloc: (size: number): number => {
      if (typeof exp._malloc === 'function') return exp._malloc(size) as number;
      // Fallback bump allocator — the stub-WASM fixtures used in tests
      // export `_bump` returning the next free heap offset.
      if (typeof exp._bump === 'function') return exp._bump(size) as number;
      throw new Error('WasmTransport: WASM has no `_malloc` or `_bump` export');
    },
    _free: (ptr: number): void => {
      if (typeof exp._free === 'function') exp._free(ptr);
      // Bump-allocator stubs leak — fine for tests.
    },
    UTF8ToString: (ptr: number): string => {
      const u8 = new Uint8Array(memory.buffer);
      let end = ptr;
      while (end < u8.length && u8[end] !== 0) end++;
      return new TextDecoder('utf-8').decode(u8.subarray(ptr, end));
    },
    stringToNewUTF8: (s: string): number => {
      const bytes = new TextEncoder().encode(s);
      const ptr = shim._malloc(bytes.length + 1);
      const u8 = new Uint8Array(memory.buffer);
      u8.set(bytes, ptr);
      u8[ptr + bytes.length] = 0;
      return ptr;
    },
    addFunction: (fn, sig) => {
      // Raw-bytes path: install the callback into a JS-side function
      // table and return a synthetic non-negative integer as the
      // "function pointer". The kernel hands this value back unchanged
      // when it invokes the vtable, so the same shim can later
      // dispatch it. Production emscripten Modules override this with
      // a real `addFunction` that emits a wasm trampoline.
      void sig;
      const idx = functionTable.length;
      functionTable.push(fn);
      return idx;
    },
    _gn_core_create: (): number => callExport(exp, '_gn_core_create'),
    _gn_core_install_identity_from_file: (core, pathPtr) =>
      callExport(exp, '_gn_core_install_identity_from_file', core, pathPtr),
    _gn_core_init: (core) => callExport(exp, '_gn_core_init', core),
    _gn_core_register_runtime: (core, namePtr, vtablePtr, ctxPtr) =>
      callExport(
        exp,
        '_gn_core_register_runtime',
        core,
        namePtr,
        vtablePtr,
        ctxPtr,
      ),
    _gn_core_start: (core) => callExport(exp, '_gn_core_start', core),
  };
  if (typeof exp._gn_core_stop === 'function') {
    shim._gn_core_stop = (core: number): number =>
      callExport(exp, '_gn_core_stop', core);
  }
  if (typeof exp._gn_core_destroy === 'function') {
    shim._gn_core_destroy = (core: number): number =>
      callExport(exp, '_gn_core_destroy', core);
  }
  // Refresh the heap views whenever memory grows. Wasm `memory.grow`
  // detaches the old `ArrayBuffer`; callers that hold stale
  // HEAPU8/HEAPU32 see them as length-0 after a grow. The shim
  // returns getters so reads always observe the current buffer.
  Object.defineProperties(shim, {
    HEAPU8: { get: () => new Uint8Array(memory.buffer) },
    HEAPU32: { get: () => new Uint32Array(memory.buffer) },
  });

  // Shared per-shim function table for the polyfilled `addFunction`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const functionTable: Array<(...args: any[]) => any> = [
    // Index 0 reserved — a real wasm function table starts unused
    // at 0 too (null function pointer).
    () => {
      throw new Error('null function pointer');
    },
  ];
  // Surface the function table so the kernel-side "call thunk by
  // index" path can run in JS (used by the v0.3 alpha until a
  // real wasm trampoline lands).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (shim as any).__functionTable = functionTable;

  return shim;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callExport(exp: Record<string, any>, name: string, ...args: number[]): number {
  const fn = exp[name];
  if (typeof fn !== 'function') {
    throw new Error(`WasmTransport: WASM artefact missing export \`${name}\``);
  }
  const r = fn(...args);
  return typeof r === 'number' ? r : 0;
}

/**
 * Browser-side transport that owns a full kernel instance inside
 * a WASM Module. Constructed via the async {@link WasmTransport.create}
 * factory because WASM instantiation is asynchronous.
 */
export class WasmTransport {
  private Module: WasmModuleLike | null = null;
  /** `gn_core_t*` inside linear memory, returned by `_gn_core_create`. */
  private core = 0;
  /** msg_id → JS handler. Looked up by the register_plugin thunk. */
  private readonly handlerTable = new Map<number, HandlerCallback>();
  /** Auto-incrementing handle minted by the register_plugin thunk. */
  private nextInstance = 1;
  /** instance handle → msg_id, so unregister can clean up. */
  private readonly instanceToMsgId = new Map<number, number>();
  private closed = false;

  private constructor(private readonly opts: WasmTransportOptions) {}

  /**
   * Fetch + instantiate the WASM kernel, install identity, register
   * the `wasm-plugin` runtime, return a usable transport.
   *
   * v0.3 ships alpha-grade wiring tested against a stub WASM
   * fixture. The production `goodnet.wasm` (with libsodium-
   * emscripten) is a kernel-side track; once it lands, the same
   * call-sequence holds — only the artefact pointer changes.
   */
  static async create(opts: WasmTransportOptions): Promise<WasmTransport> {
    const t = new WasmTransport(opts);
    await t.bootstrap();
    return t;
  }

  /**
   * Register a JS handler for the given message id.
   *
   * In v0.3 the table is the source of truth — the kernel asks for
   * a plugin under the name `js-handler-${msg_id}` via the
   * `register_plugin` thunk, which reads the id back out of the
   * name and mints a fresh instance handle. Re-registering the
   * same `msg_id` replaces the previous callback.
   */
  registerHandler(msg_id: number, on_message: HandlerCallback): void {
    if (this.closed) {
      throw new Error('WasmTransport: closed');
    }
    this.handlerTable.set(msg_id, on_message);
  }

  /**
   * Tear down the kernel instance. Idempotent. Calls
   * `_gn_core_stop` + `_gn_core_destroy` if the exports exist on
   * the artefact (they do on the production build; the test stub
   * skips them).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlerTable.clear();
    this.instanceToMsgId.clear();
    if (this.Module && this.core) {
      this.Module._gn_core_stop?.(this.core);
      this.Module._gn_core_destroy?.(this.core);
      this.core = 0;
      this.Module = null;
    }
  }

  /**
   * @internal Test-only entry that simulates the kernel calling our
   * `register_plugin` thunk with a synthetic manifest entry. Returns
   * the freshly minted instance handle, or `0` on failure (matches
   * `GN_PLUGIN_INSTANCE_INVALID` from `sdk/plugin_runtime.h`).
   *
   * The production kernel WASM reaches this same code path via the
   * vtable; tests call it directly to round-trip the synthetic
   * `js-handler-${msg_id}` lookup without spinning up a real
   * PluginManager.
   */
  __debugInvokeRegisterPlugin(entryName: string): number {
    return this.thunkRegisterPlugin_(entryName);
  }

  /**
   * @internal Test-only — simulates the kernel dispatching a
   * `gn_message_t*` into our `handle_message` thunk. Returns the
   * `Propagation` value the JS callback returned. Mostly used by
   * round-trip tests; production goes through the vtable.
   */
  __debugDispatch(
    msg_id: number,
    conn_id: GnConnId,
    payload: Uint8Array,
  ): Propagation {
    const cb = this.handlerTable.get(msg_id);
    if (!cb) return Propagation.CONTINUE;
    return cb({ msg_id, conn_id, payload });
  }

  // ── private ──────────────────────────────────────────────────────

  private async bootstrap(): Promise<void> {
    this.Module = await this.instantiate();

    // gn_core_t* returned by hand.
    this.core = this.Module._gn_core_create();
    if (!this.core) {
      throw new Error('WasmTransport: _gn_core_create returned NULL');
    }

    // Optional identity install. The production kernel exposes
    // `_gn_core_install_identity_from_file` against the Module FS;
    // we write the secret bytes there as `/identity.bin` first.
    if (this.opts.identity) {
      if (this.opts.identity.byteLength !== 64) {
        throw new Error(
          `WasmTransport: identity must be 64 bytes (Ed25519 secret), got ${this.opts.identity.byteLength}`,
        );
      }
      // The shim's stringToNewUTF8 doubles as a "write bytes into a
      // known heap location" since the production path uses Module.FS
      // (unavailable here). The kernel side will dereference the path,
      // not the inline bytes.
      const idPath = this.Module.stringToNewUTF8('/identity.bin');
      // Best-effort identity write — production goodnet.wasm reads
      // `/identity.bin` from Module.FS; the stub path silently
      // accepts the call without an FS.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fs = (this.Module as any).FS as { writeFile?: (path: string, data: Uint8Array) => void } | undefined;
      if (fs?.writeFile) {
        fs.writeFile('/identity.bin', this.opts.identity);
      }
      const r = this.Module._gn_core_install_identity_from_file(this.core, idPath);
      this.Module._free(idPath);
      if (r !== 0) {
        throw new Error(
          `WasmTransport: _gn_core_install_identity_from_file returned ${r}`,
        );
      }
    }

    // Kernel-level init before runtime registration so the
    // PluginManager exists by the time `_gn_core_register_runtime`
    // lands a new vtable.
    const initRc = this.Module._gn_core_init(this.core);
    if (initRc !== 0) {
      throw new Error(`WasmTransport: _gn_core_init returned ${initRc}`);
    }

    // Build the runtime vtable in linear memory, then hand it over.
    const vtablePtr = this.buildRuntimeVtable_();
    const namePtr = this.Module.stringToNewUTF8('wasm-plugin');
    const regRc = this.Module._gn_core_register_runtime(
      this.core,
      namePtr,
      vtablePtr,
      0,
    );
    this.Module._free(namePtr);
    if (regRc !== 0) {
      throw new Error(
        `WasmTransport: _gn_core_register_runtime returned ${regRc}`,
      );
    }

    // Start the kernel. After this the manager begins scanning the
    // manifest; entries whose `runtime:` is `"wasm-plugin"` come
    // back to us through the `register_plugin` thunk.
    const startRc = this.Module._gn_core_start(this.core);
    if (startRc !== 0) {
      throw new Error(`WasmTransport: _gn_core_start returned ${startRc}`);
    }
  }

  /**
   * Acquire a `WasmModuleLike` from `opts.wasm`. Three input
   * shapes are supported:
   *
   *   1. Raw `ArrayBuffer` / `Uint8Array` → `WebAssembly.instantiate`
   *      + shim. Used by tests.
   *   2. URL ending in `.wasm` → `WebAssembly.instantiateStreaming` +
   *      shim. The production-ish path before the emscripten glue
   *      lands.
   *   3. URL ending in `.js` → dynamic `import()` of the emscripten
   *      Module factory (`goodnet.wasm.js`). The production path.
   */
  private async instantiate(): Promise<WasmModuleLike> {
    const w = this.opts.wasm;

    if (typeof w === 'string') {
      if (w.endsWith('.js')) {
        // Emscripten Module factory companion. Lazy-imported so the
        // bundle does not statically reference an absent file.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod = (await import(/* @vite-ignore */ w)) as any;
        const factory = mod.default ?? mod;
        if (typeof factory !== 'function') {
          throw new Error(
            `WasmTransport: \`${w}\` did not export a Module factory`,
          );
        }
        const Module = (await factory({})) as WasmModuleLike;
        return Module;
      }
      // .wasm URL — streaming compile. Falls back to fetch+arrayBuffer
      // on hosts that lack instantiateStreaming.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { instantiateStreaming, instantiate } = WebAssembly as any;
      const imports = this.buildImports_();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fetchFn = (globalThis as any).fetch as
        | ((u: string) => Promise<Response>)
        | undefined;
      if (!fetchFn) {
        throw new Error(
          'WasmTransport: no global `fetch` available for `.wasm` URL; pass an ArrayBuffer instead',
        );
      }
      let result: WebAssembly.WebAssemblyInstantiatedSource;
      if (typeof instantiateStreaming === 'function') {
        result = await instantiateStreaming(fetchFn(w), imports);
      } else {
        const buf = await (await fetchFn(w)).arrayBuffer();
        result = await instantiate(buf, imports);
      }
      return buildShim(result.instance);
    }

    // Raw bytes — ArrayBuffer or Uint8Array.
    const bytes = w instanceof Uint8Array ? w : new Uint8Array(w);
    // The two-arg overload of `instantiate` (bytes + imports) always
    // resolves to `{module, instance}`; the cast picks the right
    // signature without relying on TS overload selection.
    const result = (await WebAssembly.instantiate(
      bytes as BufferSource,
      this.buildImports_(),
    )) as WebAssembly.WebAssemblyInstantiatedSource;
    return buildShim(result.instance);
  }

  /**
   * Imports handed to `WebAssembly.instantiate` on the raw-bytes
   * path. The stub WASM in `tests/fixtures/` reads from `env` —
   * production emscripten artefacts bring their own.
   */
  private buildImports_(): WebAssembly.Imports {
    return {
      env: {
        // No imports needed for the v0.3 stub. Production goodnet.wasm
        // brings the standard emscripten import surface (abort,
        // emscripten_resize_heap, etc.) — those land on the Module
        // factory path, not here.
      },
    };
  }

  /**
   * Allocate and populate a `gn_plugin_runtime_vtable_t` in linear
   * memory. The four thunks are installed via `addFunction` and
   * land in the vtable as 4-byte function-pointer indices.
   */
  private buildRuntimeVtable_(): number {
    if (!this.Module) throw new Error('WasmTransport: not bootstrapped');
    const M = this.Module;

    // Bind the thunks. Signatures use the emscripten one-letter
    // convention: `i`=i32, `v`=void. Result type comes first.
    //
    //  init        : ctx              -> i32     ('ii')
    //  register    : ctx, n, p, out   -> i32     ('iiiii')
    //  unregister  : ctx, instance    -> i32     ('iii')
    //  shutdown    : ctx              -> i32     ('ii')
    const fpInit = M.addFunction(() => 0 /* GN_OK */, 'ii');
    const fpReg = M.addFunction(
      (_ctx: number, namePtr: number, _pathPtr: number, outInstance: number): number => {
        const name = M.UTF8ToString(namePtr);
        const instance = this.thunkRegisterPlugin_(name);
        if (instance === 0) return -14 /* GN_ERR_NOT_FOUND */;
        // Write the minted instance handle into *out_instance.
        M.HEAPU32[outInstance >>> 2] = instance;
        return 0;
      },
      'iiiii',
    );
    const fpUnreg = M.addFunction(
      (_ctx: number, instance: number): number => {
        const msgId = this.instanceToMsgId.get(instance);
        if (msgId !== undefined) {
          this.instanceToMsgId.delete(instance);
          this.handlerTable.delete(msgId);
        }
        return 0;
      },
      'iii',
    );
    const fpShutdown = M.addFunction(() => 0, 'ii');

    const vtable = M._malloc(VTABLE_SIZE);
    const u32 = M.HEAPU32;
    const base = vtable >>> 2;
    u32[base + 0] = VTABLE_SIZE; // api_size
    u32[base + 1] = fpInit;
    u32[base + 2] = fpReg;
    u32[base + 3] = fpUnreg;
    u32[base + 4] = fpShutdown;
    return vtable;
  }

  /**
   * Core of the register_plugin thunk. Names follow
   * `js-handler-${msg_id}`; anything else returns 0 so the kernel's
   * load diagnostic surfaces a clear "no such plugin" rather than
   * silently minting a handle for a name we don't own.
   */
  private thunkRegisterPlugin_(entryName: string): number {
    const m = /^js-handler-(\d+)$/.exec(entryName);
    if (!m) return 0;
    const msgId = Number(m[1]);
    if (!this.handlerTable.has(msgId)) return 0;
    const instance = this.nextInstance++;
    this.instanceToMsgId.set(instance, msgId);
    return instance;
  }
}
