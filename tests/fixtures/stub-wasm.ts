// SPDX-License-Identifier: MIT
/**
 * Stub WASM fixture for `WasmTransport` v0.3 tests.
 *
 * Hand-crafted minimal WebAssembly module exporting the same shape
 * the production `goodnet.wasm` will expose, but with every entry
 * point reduced to a no-op:
 *
 *   - `memory`                                 — 1 page of linear memory
 *   - `_gn_core_create() -> i32`               — returns 1 (non-NULL pointer)
 *   - `_gn_core_init(core) -> i32`             — returns 0 (GN_OK)
 *   - `_gn_core_install_identity_from_file(core, path_ptr) -> i32` — returns 0
 *   - `_gn_core_register_runtime(core, name, vtable, ctx) -> i32`  — returns 0
 *   - `_gn_core_start(core) -> i32`            — returns 0
 *   - `_bump(size) -> i32`                     — bump allocator from offset 16
 *
 * The fixture keeps the suite self-contained — no dependency on a
 * pre-built `goodnet.wasm` blob, no emscripten toolchain in CI. The
 * production wiring path (Module factory + dynCalled vtable) is
 * exercised in the kernel-side build instead.
 */

/** Encode a u32 as LEB128 (variable-length). */
function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

/** Encode an i32 as signed LEB128. */
function sleb(n: number): number[] {
  const out: number[] = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) {
      more = false;
    } else {
      b |= 0x80;
    }
    out.push(b);
  }
  return out;
}

/** Encode a string as a length-prefixed UTF-8 byte sequence. */
function name(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  return [...uleb(bytes.length), ...bytes];
}

/** Wrap a section payload with its section id + length prefix. */
function section(id: number, payload: number[]): number[] {
  return [id, ...uleb(payload.length), ...payload];
}

/** Wrap a vec<T>: length-prefixed sequence of byte arrays. */
function vec(items: number[][]): number[] {
  const out: number[] = [...uleb(items.length)];
  for (const it of items) out.push(...it);
  return out;
}

/** Build the stub-WASM bytes. */
export function buildStubWasm(): Uint8Array {
  // WASM type opcodes.
  const T_i32 = 0x7f;
  // Numeric instructions.
  const OP_local_get = 0x20;
  const OP_local_set = 0x21;
  const OP_i32_const = 0x41;
  const OP_i32_add = 0x6a;
  const OP_i32_load = 0x28;
  const OP_i32_store = 0x36;
  const END = 0x0b;

  // ── Type section ─────────────────────────────────────────────
  // Two function types we'll use:
  //   t0: () -> i32                     — for _gn_core_create
  //   t1: (i32) -> i32                  — for _gn_core_init, _gn_core_start, _bump
  //   t2: (i32, i32) -> i32             — for _gn_core_install_identity_from_file
  //   t3: (i32, i32, i32, i32) -> i32   — for _gn_core_register_runtime
  const types = vec([
    [0x60, ...uleb(0), 0x01, T_i32],
    [0x60, ...uleb(1), T_i32, 0x01, T_i32],
    [0x60, ...uleb(2), T_i32, T_i32, 0x01, T_i32],
    [0x60, ...uleb(4), T_i32, T_i32, T_i32, T_i32, 0x01, T_i32],
  ]);

  // ── Function section ─────────────────────────────────────────
  //   f0 _gn_core_create                : t0
  //   f1 _gn_core_init                  : t1
  //   f2 _gn_core_install_identity_from_file : t2
  //   f3 _gn_core_register_runtime      : t3
  //   f4 _gn_core_start                 : t1
  //   f5 _bump                          : t1
  const funcs = vec([[0], [1], [2], [3], [1], [1]].map((v) => v));

  // ── Memory section ───────────────────────────────────────────
  // One page (64 KiB), no max.
  const mems = vec([[0x00, ...uleb(1)]]);

  // ── Global section ───────────────────────────────────────────
  // g0 = mutable i32 bump pointer initialised to 16. The first 16
  // bytes are reserved so 0 stays a clean "null" sentinel.
  const globals = vec([
    [T_i32, 0x01 /* mutable */, OP_i32_const, ...sleb(16), END],
  ]);

  // ── Export section ───────────────────────────────────────────
  // memory + the six C entry points.
  const exports = vec([
    [...name('memory'), 0x02, ...uleb(0)],
    [...name('_gn_core_create'), 0x00, ...uleb(0)],
    [...name('_gn_core_init'), 0x00, ...uleb(1)],
    [...name('_gn_core_install_identity_from_file'), 0x00, ...uleb(2)],
    [...name('_gn_core_register_runtime'), 0x00, ...uleb(3)],
    [...name('_gn_core_start'), 0x00, ...uleb(4)],
    [...name('_bump'), 0x00, ...uleb(5)],
  ]);

  // ── Code section ─────────────────────────────────────────────
  // Each function: vec<local> = empty, then opcodes, then END.
  // The body itself is length-prefixed.
  function body(opcodes: number[]): number[] {
    const inner = [0x00 /* zero locals */, ...opcodes, END];
    return [...uleb(inner.length), ...inner];
  }

  // f0 _gn_core_create: i32.const 1
  const code0 = body([OP_i32_const, ...sleb(1)]);
  // f1 _gn_core_init(core): i32.const 0
  const code1 = body([OP_i32_const, ...sleb(0)]);
  // f2 _gn_core_install_identity_from_file(core, path): i32.const 0
  const code2 = body([OP_i32_const, ...sleb(0)]);
  // f3 _gn_core_register_runtime(core, name, vtable, ctx): i32.const 0
  const code3 = body([OP_i32_const, ...sleb(0)]);
  // f4 _gn_core_start(core): i32.const 0
  const code4 = body([OP_i32_const, ...sleb(0)]);
  // f5 _bump(size):
  //   r = bump_ptr
  //   bump_ptr = bump_ptr + size
  //   return r
  // Globals encoded as: global.get 0; local.get 0; i32.add; global.set 0;
  // followed by global.get 0 - size... easier: r = global.get; new = r + size; set; return r.
  // We need a local to stash r. Re-do with locals = [1 of i32].
  const bumpInner = [
    0x01, // 1 local entry
    0x01,
    T_i32, // count=1 type=i32
    // r = global.get 0
    0x23,
    ...uleb(0),
    0x21,
    ...uleb(1), // local.set 1 (r)
    // global.set 0 = r + size
    0x20,
    ...uleb(1), // local.get 1 (r)
    OP_local_get,
    ...uleb(0), // local.get 0 (size)
    OP_i32_add,
    0x24,
    ...uleb(0), // global.set 0
    // return r
    OP_local_get,
    ...uleb(1),
    END,
  ];
  void OP_local_set;
  void OP_i32_load;
  void OP_i32_store;
  const code5 = [...uleb(bumpInner.length), ...bumpInner];

  const codes = vec([code0, code1, code2, code3, code4, code5]);

  // ── Assemble ─────────────────────────────────────────────────
  const bytes = [
    0x00,
    0x61,
    0x73,
    0x6d, // \0asm
    0x01,
    0x00,
    0x00,
    0x00, // version 1
    ...section(1, types),
    ...section(3, funcs),
    ...section(5, mems),
    ...section(6, globals),
    ...section(7, exports),
    ...section(10, codes),
  ];
  return new Uint8Array(bytes);
}
