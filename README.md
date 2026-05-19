# goodnet-js — JavaScript / TypeScript client for the goodnetd WS gateway

`npm`-installable wrapper that talks the JSON-RPC dialect served by
the `gn.handler.web-api-proxy` plugin. The browser tab connects to a
running `goodnetd` over `ws://goodnetd-host:9100` and writes code as
if the kernel were native — the gateway proxies every call into the
real goodnet peer.

## Status — v0.1

The wire envelope is pinned. The kernel-side handler currently
replies with `"not implemented in v0.1 skeleton"` to every advertised
method (see `plugins/handlers/web_api_proxy/`); v0.2 fills the
dispatch in without breaking this package's contract.

What this package ships:

- `GoodnetClient` — single-WS, request/response, notification
  subscriptions.
- TypeScript-first, browser-default. Node consumers inject `ws`
  through the constructor.
- Vitest-driven mock-WS smoke suite.

## Install

```sh
npm install goodnet-js
```

The package has zero runtime dependencies in the browser bundle.
Node consumers need the `ws` npm package:

```sh
npm install ws
```

## Browser usage

```ts
import { GoodnetClient } from 'goodnet-js';

const gn = new GoodnetClient({ url: 'ws://localhost:9100' });
await gn.ready();

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

## Node.js usage

The browser's built-in `WebSocket` isn't available; pass `ws`:

```ts
import WebSocket from 'ws';
import { GoodnetClient } from 'goodnet-js';

const gn = new GoodnetClient({
  url: 'ws://localhost:9100',
  WebSocket: WebSocket as never,
});
```

## Ten-line counter app

```ts
import { GoodnetClient } from 'goodnet-js';
const gn = new GoodnetClient({ url: 'ws://localhost:9100' });
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

## Wire dialect (v0.1)

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

Methods advertised by v0.1:
`core.connect`, `core.send`, `core.subscribe`, `core.disconnect`,
`core.handlers.list`, `core.links.list`.

## Develop

```sh
npm install
npm test        # vitest run — mock-WS smoke
npm run build   # tsup → dist/index.{mjs,cjs,d.ts}
```

## License

MIT, matching the upstream kernel.
