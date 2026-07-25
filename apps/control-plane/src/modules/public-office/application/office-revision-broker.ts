import type { Notification, PoolClient } from "pg";

import type { DatabasePool } from "../../../platform/db/pool.js";

const CHANNEL = "control_plane_office_revision_v1";

export type OfficeRevisionSubscriber = (revision: number) => void;

export interface OfficeRevisionBroker {
  start(): Promise<void>;
  subscribe(
    officeId: string,
    subscriber: OfficeRevisionSubscriber,
  ): () => void;
  close(): Promise<void>;
}

export function createNoopOfficeRevisionBroker(): OfficeRevisionBroker {
  return {
    async start() {},
    subscribe() {
      return () => undefined;
    },
    async close() {},
  };
}

export function createOfficeRevisionBroker(
  pool: DatabasePool,
  onError: (code: string) => void = () => undefined,
): OfficeRevisionBroker {
  const subscribers = new Map<string, Set<OfficeRevisionSubscriber>>();
  let client: PoolClient | null = null;
  let starting: Promise<void> | null = null;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const start = async (): Promise<void> => {
    if (closed || client !== null) return;
    if (starting !== null) return starting;
    starting = (async () => {
      const nextClient = await pool.connect();
      if (closed) {
        nextClient.release();
        return;
      }
      nextClient.on("notification", handleNotification);
      nextClient.on("error", handleClientError);
      try {
        await nextClient.query(`LISTEN ${CHANNEL}`);
        client = nextClient;
        wakeAll();
      } catch (error) {
        nextClient.removeListener("notification", handleNotification);
        nextClient.removeListener("error", handleClientError);
        nextClient.release(true);
        throw error;
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void start().catch((error: unknown) => {
        onError(errorCode(error));
        scheduleReconnect();
      });
    }, 1_000);
    reconnectTimer.unref();
  };

  function handleClientError(error: Error): void {
    onError(errorCode(error));
    const failedClient = client;
    client = null;
    if (failedClient !== null) {
      failedClient.removeListener("notification", handleNotification);
      failedClient.removeListener("error", handleClientError);
      failedClient.release(true);
    }
    scheduleReconnect();
  }

  function handleNotification(notification: Notification): void {
    if (notification.channel !== CHANNEL || notification.payload === undefined) {
      return;
    }
    try {
      const parsed = JSON.parse(notification.payload) as {
        office_id?: unknown;
        revision?: unknown;
      };
      if (
        typeof parsed.office_id !== "string" ||
        typeof parsed.revision !== "number" ||
        !Number.isSafeInteger(parsed.revision) ||
        parsed.revision < 1
      ) {
        return;
      }
      for (const subscriber of subscribers.get(parsed.office_id) ?? []) {
        subscriber(parsed.revision);
      }
    } catch {
      onError("invalid_notification");
    }
  }

  function wakeAll(): void {
    for (const officeSubscribers of subscribers.values()) {
      for (const subscriber of officeSubscribers) subscriber(0);
    }
  }

  return {
    start,
    subscribe(officeId, subscriber) {
      let officeSubscribers = subscribers.get(officeId);
      if (officeSubscribers === undefined) {
        officeSubscribers = new Set();
        subscribers.set(officeId, officeSubscribers);
      }
      officeSubscribers.add(subscriber);
      return () => {
        officeSubscribers?.delete(subscriber);
        if (officeSubscribers?.size === 0) subscribers.delete(officeId);
      };
    },
    async close() {
      closed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      await starting?.catch(() => undefined);
      const activeClient = client;
      client = null;
      if (activeClient !== null) {
        activeClient.removeListener("notification", handleNotification);
        activeClient.removeListener("error", handleClientError);
        await activeClient.query(`UNLISTEN ${CHANNEL}`).catch(() => undefined);
        activeClient.release();
      }
      subscribers.clear();
    },
  };
}

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "unknown";
}
