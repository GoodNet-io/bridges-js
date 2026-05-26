// SPDX-License-Identifier: MIT
/**
 * WasmTransport — full GoodNet kernel running in-process.
 *
 * Instantiates the goodnet.wasm kernel blob inside the current
 * JavaScript context (browser tab or Node worker). No daemon process
 * required; the browser tab IS the peer.
 *
 * The on() method registers a JS function as a kernel-native plugin
 * via the gn_plugin_runtime_vtable_t C ABI (sdk/plugin_runtime.h).
 * The kernel dispatches gn_message_t* envelopes into the JS callback
 * directly — the payload is a zero-copy Uint8Array view into the
 * WASM Module's linear memory, valid only during the callback.
 *
 * connect() / send() / disconnect() call the corresponding kernel
 * WASM exports (_gn_core_connect, _gn_core_send, _gn_core_disconnect).
 * These exports are available once the production goodnet.wasm
 * (libsodium-emscripten build) is wired in; the current stub throws
 * until that build lands.
 *
 * Usage:
 * ```ts
 * const gn = await WasmTransport.create({ wasm: '/goodnet.wasm' });
 * const { conn_id } = await gn.connect('tcp://peer.example:9100');
 * gn.on(0x0700, (payload) => console.log(payload));
 * ```
 */

import type {
    GoodnetTransport,
    MessageHandler,
    Subscription,
    ConnectResult,
} from './transport.js';

export interface WasmTransportOptions {
    /** URL or pre-fetched bytes of the goodnet.wasm blob. */
    wasm: string | ArrayBuffer | Uint8Array;
    /** Optional 64-byte Ed25519 secret for the kernel identity. */
    identity?: Uint8Array;
}

/**
 * Mirrors gn_propagation_t (sdk/handler.h).
 * Returned from the kernel dispatcher to the thunk; the value
 * is forwarded to the kernel as the handler's propagation decision.
 */
export enum Propagation {
    CONSUMED     = 1,
    CONTINUE     = 2,
    PASS_THROUGH = 3,
}

/**
 * Low-level callback type used internally by the WASM bootstrap.
 * Application code uses the GoodnetTransport.on() interface instead.
 */
export type HandlerCallback = (msg_id: number, conn_id: bigint, payload: Uint8Array) => Propagation;

export class WasmTransportError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WasmTransportError';
    }
}

/**
 * Full in-process GoodNet kernel. Implements GoodnetTransport so
 * application code is identical regardless of whether the backend
 * is a remote daemon (WsTransport) or an in-process kernel (WasmTransport).
 */
export class WasmTransport implements GoodnetTransport {
    private readonly handlers = new Map<number, Set<MessageHandler>>();
    private closed = false;

    // opts retained for when the WASM bootstrap is wired
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private constructor(_opts: WasmTransportOptions) {}

    /**
     * Instantiate the WASM kernel and return a ready transport.
     *
     * Production goodnet.wasm (libsodium-emscripten) is a kernel-side
     * build track. Until it lands, this factory is functional as a
     * type-correct stub — on() registrations are accepted, connect/send
     * operations throw WasmTransportError with a clear message.
     */
    static async create(opts: WasmTransportOptions): Promise<WasmTransport> {
        return new WasmTransport(opts);
    }

    /**
     * Open a peer connection through the in-process kernel.
     * Requires the production goodnet.wasm build with _gn_core_connect export.
     */
    async connect(_uri: string): Promise<ConnectResult> {
        throw new WasmTransportError(
            'WasmTransport.connect: kernel WASM build not yet wired — ' +
            'use WsTransport for thin-client access to a running goodnetd',
        );
    }

    /**
     * Subscribe to inbound frames for msg_id.
     *
     * Internally installs a kernel-native plugin via the
     * gn_plugin_runtime_vtable_t C ABI. Until the WASM bootstrap is
     * wired, callbacks are stored in JS and invokable through
     * __debugDispatch() for testing.
     */
    on(msg_id: number, handler: MessageHandler): Subscription {
        let set = this.handlers.get(msg_id);
        if (!set) {
            set = new Set();
            this.handlers.set(msg_id, set);
        }
        set.add(handler);
        return {
            unsubscribe: () => {
                const s = this.handlers.get(msg_id);
                if (!s) return;
                s.delete(handler);
                if (s.size === 0) this.handlers.delete(msg_id);
            },
        };
    }

    async send(_conn_id: bigint, _msg_id: number, _payload: Uint8Array): Promise<void> {
        throw new WasmTransportError('WasmTransport.send: kernel WASM not yet wired');
    }

    async disconnect(_conn_id: bigint): Promise<void> {
        throw new WasmTransportError('WasmTransport.disconnect: kernel WASM not yet wired');
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.handlers.clear();
    }

    /**
     * @internal Test helper — simulates the kernel dispatching an inbound
     * message into registered on() handlers. Returns true if at least one
     * handler was invoked.
     */
    __debugDispatch(msg_id: number, conn_id: bigint, payload: Uint8Array): boolean {
        const set = this.handlers.get(msg_id);
        if (!set || set.size === 0) return false;
        for (const h of set) {
            try { h(payload, conn_id); } catch { /* user cb threw */ }
        }
        return true;
    }
}
