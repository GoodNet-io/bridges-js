# goodnet-js — JavaScript / TypeScript client for goodnetd

`npm`-installable wrapper around the GoodNet kernel. One
`GoodnetClient` surface, two transports:

| Transport | When to pick | Bundle | Daemon |
| ---       | ---          | ---    | ---    |
| **WS thin client** (`{url: 'ws://...'}`) | Browser tab talks to a remote `goodnetd` via the `gn.handler.web-api-proxy` JSON-RPC. | ~10 KB | Needs `goodnetd` running somewhere. |
| **WASM full kernel** (`{wasm: '/goodnet.wasm'}`) | Browser tab _is_ a full GoodNet peer — no daemon at all. JS handlers run as native plugins of the in-tab kernel via the C ABI in `sdk/plugin_runtime.h`. | ~600 KB-1.5 MB (lazy fetch; unused if WS picked). | No. |

## Status — v0.2

The WS path is unchanged from v0.1 — the gateway-side handler still
replies with `"not implemented in v0.1 skeleton"` to every advertised
method (see `plugins/handlers/web_api_proxy/`); v0.2 fills the
dispatch in without breaking this package's contract.

The WASM path ships in v0.2 as a **stable type surface** —
`WasmTransport.create()` currently throws a documented
"pending Module exports wire-up" error, because the emscripten
glue + `EXPORTED_FUNCTIONS` list still needs pinning on the kernel
side (kernel commit `4e3558d` landed `sdk/plugin_runtime.h`; the
companion `goodnet.wasm` artefact follows). Apps can be written
against the v0.2 API and they will keep compiling as the impl
lands in v0.3.x.

## Install

```sh
npm install goodnet-js
```

Zero runtime dependencies in the browser bundle. Node consumers
need the `ws` npm package for the WS path:

```sh
npm install ws
```

## Browser usage — WS thin client

```ts
import { GoodnetClient } from 'goodnet-js';

const gn = await GoodnetClient.create({ url: 'ws://localhost:9100' });

const { conn_id, peer_pubkey } = await gn.connect('tcp://peer.example:9100');
console.log('peer pubkey:', peer_pubkey);

await gn.send(conn_id, 0x0610, new TextEncoder().encode('hello'));

const sub = gn.subscribe(conn_id, 0x0610, (payload) => {
  console.log('inbound:', new TextDecoder().decode(payload));
});

// ...later
sub.unsubscribe();
await gn.disconnect(conn_id);
gn.close();
```

`GoodnetClient.create` is async — it awaits the WS handshake (and,
on the WASM path, the kernel boot) so the rest of your code can
assume the transport is up.

## Browser usage — WASM full kernel (v0.2 surface, impl pending)

```ts
import { GoodnetClient, Propagation } from 'goodnet-js';

const gn = await GoodnetClient.create({
  wasm: '/goodnet.wasm',         // URL or pre-fetched ArrayBuffer
  // identity: new Uint8Array(64), // optional Ed25519 secret
});

// Register a JS function as a kernel-side plugin. The callback
// runs in the GoodNet handler chain just like a native plugin
// loaded from a manifest entry.
await gn.handler({
  msg_id: 0x0610,
  on_message: (env) => {
    // env.payload is a Uint8Array view into linear memory —
    // valid only during this call. Copy if you need to retain it.
    console.log(`peer=${env.conn_id}:`, new TextDecoder().decode(env.payload));
    return Propagation.CONSUMED;
  },
});

gn.close();
```

The same `handler({msg_id, on_message})` call works on the WS
transport too — it falls back to a wildcard `core.subscribe` plus a
base64 decode. On the WASM transport the JS callback is invoked
directly from C via dynCall and gets a zero-copy memory view (no
base64, no JSON).

## Node.js usage

The browser's built-in `WebSocket` isn't available; pass `ws`:

```ts
import WebSocket from 'ws';
import { GoodnetClient } from 'goodnet-js';

const gn = await GoodnetClient.create({
  url: 'ws://localhost:9100',
  WebSocket: WebSocket as never,
});
```

## Ten-line counter app (WS)

```ts
import { GoodnetClient } from 'goodnet-js';
const gn = await GoodnetClient.create({ url: 'ws://localhost:9100' });
const { conn_id } = await gn.connect('tcp://peer.example:9100');
let n = 0;
gn.subscribe(conn_id, 0x0610, (p) => {
  n += new DataView(p.buffer).getUint32(0, false);
  console.log('counter =', n);
});
setInterval(() => {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, 1, false);
  void gn.send(conn_id, 0x0610, buf);
}, 1000);
```

## Wire dialect (WS, v0.1 unchanged)

Each call serialises as a JSON-RPC 2.0 frame:

```json
{ "jsonrpc": "2.0", "method": "core.connect", "id": "1", "params": { "uri": "..." } }
```

Responses match by `id`:

```json
{ "jsonrpc": "2.0", "id": "1", "result": { "conn_id": 17, "peer_pubkey": "deadbeef" } }
```

Notifications carry no `id`:

```json
{ "jsonrpc": "2.0", "method": "core.notify",
  "params": { "conn_id": 17, "msg_id": 1552, "payload_b64": "aGVsbG8=" } }
```

Methods advertised by the WS dialect:
`core.connect`, `core.send`, `core.subscribe`, `core.disconnect`,
`core.handlers.list`, `core.links.list`.

## WASM transport — ABI sketch

The WASM path bypasses JSON-RPC entirely. On boot, `WasmTransport`:

1. Fetches + instantiates `goodnet.wasm` (emscripten Module).
2. Calls `_gn_core_create` and installs an identity.
3. Builds a `gn_plugin_runtime_vtable_t` in linear memory — four
   function pointers produced by `Module.addFunction(thunk, sig)`.
4. Registers the runtime under the name `"wasm-plugin"` via
   `_gn_core_register_runtime(core, name, vtable, ctx)`.

`gn.handler({msg_id, on_message})` then appends a synthetic
manifest entry `{runtime:"wasm-plugin", path:"js://msg_id_N"}`.
The kernel's PluginManager calls our `register_plugin` thunk; we
build a `gn_handler_vtable_t` whose `handle_message` thunk dynCalls
back into JS with the `gn_message_t*`, and the JS side reads the
payload via `Module.HEAPU8.subarray(p, p + n)` — zero copy.

ABI source-of-truth: `sdk/plugin_runtime.h` (kernel commit
`4e3558d`). The contract is stable; the JS-side dynCall thunking is
gated on the emscripten Module exports being pinned, which lands in
v0.3.x.

## Develop

```sh
npm install
npm test        # vitest run — mock-WS smoke + WASM surface tests
npm run build   # tsup → dist/index.{mjs,cjs,d.ts}
```

## License

MIT, matching the upstream kernel.
