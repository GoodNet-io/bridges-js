# goodnet-js

TypeScript / JavaScript client for the GoodNet kernel. Two transports,
one interface — application code is identical regardless of which backend
is active.

## Transports

| Transport | How it works | When to use |
|-----------|-------------|-------------|
| **WsTransport** | Thin JSON-RPC client over WebSocket to a running `goodnetd` daemon. ~10 KB bundle. | Server-side apps, dashboards, any environment where a daemon runs nearby. |
| **WasmTransport** | Full GoodNet kernel compiled to WASM, running in-process. No daemon. The browser tab IS the peer. | Browser-as-peer, offline-capable apps, environments where you cannot run a daemon. |

Both implement `GoodnetTransport`. The backend is chosen once at startup
and invisible from that point on.

## Install

```sh
npm install goodnet-js
```

Zero runtime dependencies in the browser bundle. Node consumers need `ws`:

```sh
npm install ws
```

## Usage

```ts
import { Goodnet } from 'goodnet-js';

// Connect to a running goodnetd daemon:
const gn = await Goodnet.create({ url: 'ws://localhost:9100' });

// — or — run the kernel in-process (no daemon):
const gn = await Goodnet.create({ wasm: '/goodnet.wasm' });

// The rest of the code is the same either way:
const { conn_id } = await gn.connect('tcp://peer.example:9100');

gn.on(0x0700, (payload, conn_id) => {
    console.log('from', conn_id, new TextDecoder().decode(payload));
});

await gn.send(conn_id, 0x0700, new TextEncoder().encode('hello'));

// ...later
await gn.disconnect(conn_id);
gn.close();
```

## Node.js

Pass the `ws` constructor explicitly — the package is browser-first:

```ts
import WebSocket from 'ws';
import { Goodnet } from 'goodnet-js';

const gn = await Goodnet.create({ url: 'ws://localhost:9100', WebSocket });
```

## GoodnetTransport interface

```ts
interface GoodnetTransport {
    connect(uri: string): Promise<ConnectResult>;          // conn_id: bigint
    on(msg_id: number, handler: MessageHandler): Subscription;
    send(conn_id: bigint, msg_id: number, payload: Uint8Array): Promise<void>;
    disconnect(conn_id: bigint): Promise<void>;
    close(): void;
}
```

`conn_id` is `bigint` throughout — it mirrors `gn_conn_id_t` (uint64) in
the C kernel ABI.

## Using transports directly

```ts
import { WsTransport, WasmTransport } from 'goodnet-js';

// WsTransport factory:
const ws = await WsTransport.connect('ws://localhost:9100');

// WasmTransport factory:
const wasm = await WasmTransport.create({ wasm: '/goodnet.wasm' });
```

## Wire dialect (WsTransport)

Each call is a JSON-RPC 2.0 frame matched by `id`:

```json
{ "jsonrpc": "2.0", "method": "core.connect", "id": "1",
  "params": { "uri": "tcp://peer:9100" } }

{ "jsonrpc": "2.0", "id": "1",
  "result": { "conn_id": 17, "peer_pubkey": "deadbeef..." } }
```

Inbound notifications carry no `id`:

```json
{ "jsonrpc": "2.0", "method": "core.notify",
  "params": { "conn_id": 17, "msg_id": 1792, "payload_b64": "aGVsbG8=" } }
```

Methods: `core.connect`, `core.send`, `core.subscribe`,
`core.disconnect`, `core.handlers.list`, `core.links.list`.

## WasmTransport status

The full WASM kernel build (goodnet.wasm with libsodium-emscripten) is a
kernel-side track. Until it lands, `WasmTransport.create()` returns a
type-correct instance; `on()` and `close()` work immediately;
`connect()`, `send()`, and `disconnect()` throw `WasmTransportError` with
a clear message. Tests use `__debugDispatch()` to exercise handler logic
without the WASM binary.

## Develop

```sh
npm install
npm test        # vitest — 12 tests
npm run build   # tsup → dist/
```

## License

MIT, matching the upstream kernel.
