// SPDX-License-Identifier: MIT
export type MessageHandler = (payload: Uint8Array, conn_id: bigint) => void;

export interface Subscription {
    unsubscribe(): void;
}

export interface ConnectResult {
    conn_id: bigint;
    peer_pubkey: string;
}

export interface GoodnetTransport {
    /** Open a GoodNet connection to the given URI. */
    connect(uri: string): Promise<ConnectResult>;
    /** Subscribe to inbound frames with the given msg_id. */
    on(msg_id: number, handler: MessageHandler): Subscription;
    send(conn_id: bigint, msg_id: number, payload: Uint8Array): Promise<void>;
    disconnect(conn_id: bigint): Promise<void>;
    close(): void;
}
