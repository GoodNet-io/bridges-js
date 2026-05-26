// SPDX-License-Identifier: MIT
/**
 * goodnet-js — JavaScript / TypeScript client for the GoodNet kernel.
 *
 * Two transports, one interface:
 *
 *   WsTransport   — thin JSON-RPC client over WebSocket to a running
 *                   goodnetd daemon. ~10 KB bundle, needs a daemon.
 *
 *   WasmTransport — full kernel running in-process (browser tab or
 *                   Node worker). No daemon required.
 *
 * Application code depends only on GoodnetTransport:
 *
 * ```ts
 * import { Goodnet } from 'goodnet-js';
 *
 * const gn = await Goodnet.create({ url: 'ws://localhost:9100' });
 * // or for in-process kernel:
 * const gn = await Goodnet.create({ wasm: '/goodnet.wasm' });
 *
 * const { conn_id } = await gn.connect('tcp://peer.example:9100');
 * gn.on(0x0700, (payload) => console.log(new TextDecoder().decode(payload)));
 * await gn.send(conn_id, 0x0700, new TextEncoder().encode('hello'));
 * ```
 *
 * Node.js — pass the `ws` constructor explicitly:
 * ```ts
 * import WebSocket from 'ws';
 * const gn = await Goodnet.create({ url: 'ws://...', WebSocket });
 * ```
 */

export type {
    GoodnetTransport,
    MessageHandler,
    ConnectResult,
    Subscription,
} from './transport.js';

export {
    WsTransport,
    WsTransportError,
    type WsTransportWebSocketCtor,
} from './WsTransport.js';

export {
    WasmTransport,
    WasmTransportError,
    Propagation,
    type WasmTransportOptions,
    type HandlerCallback,
} from './WasmTransport.js';

import type { GoodnetTransport } from './transport.js';
import { WsTransport, type WsTransportWebSocketCtor } from './WsTransport.js';
import { WasmTransport, type WasmTransportOptions } from './WasmTransport.js';

type WsCreateOpts   = { url: string; WebSocket?: WsTransportWebSocketCtor };
type WasmCreateOpts = WasmTransportOptions;

/**
 * Pick a backend and return a ready GoodnetTransport.
 *
 *   Goodnet.create({ url })   → WsTransport  (connects to goodnetd)
 *   Goodnet.create({ wasm })  → WasmTransport (in-process kernel)
 */
export const Goodnet = {
    create(opts: WsCreateOpts | WasmCreateOpts): Promise<GoodnetTransport> {
        if ('url' in opts) return WsTransport.connect(opts.url, opts.WebSocket);
        return WasmTransport.create(opts);
    },
};
