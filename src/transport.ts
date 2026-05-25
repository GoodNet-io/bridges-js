// SPDX-License-Identifier: MIT
export type MessageHandler = (payload: Uint8Array, conn_id: bigint) => void;

export interface Subscription {
    unsubscribe(): void;
}

export interface GoodnetTransport {
    on(msg_id: number, handler: MessageHandler): Subscription;
    send(conn_id: bigint, msg_id: number, payload: Uint8Array): Promise<void>;
    disconnect(conn_id: bigint): Promise<void>;
    close(): void;
}
