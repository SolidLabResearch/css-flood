#!/usr/bin/env node

import { AuthFetchCache, fromNow } from "./auth-fetch-cache.js";
import { CliArgs } from "./css-flood-args.js";
import { Counter, discardBodyData } from "./css-flood-steps";
import { RDFContentTypeMap, RDFExtMap, RDFTypeValues } from "./rdf-helpers";
import { AnyFetchResponseType } from "./generic-fetch";

//spec: https://solidproject.org/TR/2022/notifications-protocol-20221231
//see also: https://communitysolidserver.github.io/CommunitySolidServer/6.x/usage/notifications/

interface NotificationsSubscription {
  userIndex: number;
  id: string;
  type: "websocket" | "webhook";
  topic: string;
  receiveFrom?: string;
  sendTo?: string;
}

interface NotificationsApiRequest {
  "@context": ["https://www.w3.org/ns/solid/notification/v1"];
  type:
    | "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023"
    | "http://www.w3.org/ns/solid/notifications#WebhookChannel2023";
  topic: string;
  sendTo?: string;
  startAt?: string;
  endAt?: string;
  rate?: string;
  accept?: string;
}

interface NotificationsApiReply {
  "@context": any;
  id: string;
  type:
    | "http://www.w3.org/ns/solid/notifications#WebSocketChannel2023"
    | "http://www.w3.org/ns/solid/notifications#WebhookChannel2023";
  topic: string;
  receiveFrom?: string;
  sendTo?: string;
}

//The format in which notifications arrive at websockets or webhooks
interface Notification {
  "@context": any;
  id: string;
  type: "Create" | "Update" | "Delete" | "Add" | "Remove";
  object: string;
  state: string;
  published: string;
}

const notificationSubscriptions: NotificationsSubscription[] = [];

export async function stepNotificationsSubscribe(
  authFetchCache: AuthFetchCache,
  cli: CliArgs,
  counter: Counter
) {
  let curUserIndex = 0;
  for (let i = 0; i < cli.notificationSubscriptionCount; i++) {
    curUserIndex = curUserIndex + 1 >= cli.userCount ? 0 : curUserIndex + 1;

    const fetchTimeoutMs = 2000;
    try {
      const account = `user${curUserIndex}`;
      const aFetch = await authFetchCache.getAuthFetcher(curUserIndex);
      const options: any = {
        method: "POST",
        // @ts-ignore
        signal: AbortSignal.timeout(fetchTimeoutMs),
      };

      //TODO: the .notifications/ URL is currently hardcoded. It is cleaner to find this URL automatically.
      //      See https://communitysolidserver.github.io/CommunitySolidServer/6.x/usage/notifications/
      const url = `${cli.cssBaseUrl}${account}/.notifications/${
        cli.notificationChannelType === "websocket"
          ? "WebSocketChannel2023/"
          : "WebhookChannel2023/"
      }`;
      options.headers = {
        "Content-type": "application/application/json",
      };
      const notificationRequest: NotificationsApiRequest = {
        "@context": ["https://www.w3.org/ns/solid/notification/v1"],
        type: `http://www.w3.org/ns/solid/notifications#${
          cli.notificationChannelType === "websocket"
            ? "WebSocketChannel2023"
            : "WebhookChannel2023"
        }`,
        topic: `${cli.cssBaseUrl}${account}/${cli.podFilename}`,
      };
      if (cli.notificationChannelType === "webhook") {
        notificationRequest.sendTo = cli.notificationWebhookTarget;
      }
      options.body = notificationRequest;
      const res: AnyFetchResponseType = await aFetch(url, options);

      if (!res.ok) {
        const bodyError = await res.text();
        const errorMessage =
          `${res.status} - Notification subscribe with account ${account}, ` +
          `target ${notificationRequest.topic} URL "${url}" failed: ${bodyError}`;
        console.error(errorMessage);
        return;
      } else {
        const apiReply: NotificationsApiReply = <NotificationsApiReply>(
          (<unknown>await res.json)
        );
        const subscription: NotificationsSubscription = {
          userIndex: curUserIndex,
          id: apiReply.id,
          type: cli.notificationChannelType,
          topic: apiReply.topic,
          receiveFrom: apiReply.receiveFrom,
          sendTo: apiReply.sendTo,
        };
        notificationSubscriptions.push(subscription);
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        console.error(
          `Notification subscription took longer than ${fetchTimeoutMs} ms: aborted`
        );
        return;
      }
      console.error(e);
    }
  }
}

export async function stepNotificationsConnectWebsockets(
  authFetchCache: AuthFetchCache,
  cli: CliArgs,
  counter: Counter
) {
  //TODO
  throw new Error("Not yet implemented");
}

export async function stepNotificationsDelete(
  authFetchCache: AuthFetchCache,
  cli: CliArgs,
  counter: Counter
) {
  const fetchTimeoutMs = 2000;
  for (const subscription of notificationSubscriptions) {
    try {
      const account = `user${subscription.userIndex}`;
      const aFetch = await authFetchCache.getAuthFetcher(
        subscription.userIndex
      );
      const options: any = {
        method: "DELETE",
        // @ts-ignore
        signal: AbortSignal.timeout(fetchTimeoutMs),
      };

      const res: AnyFetchResponseType = await aFetch(subscription.id, options);

      if (!res.ok) {
        const bodyError = await res.text();
        const errorMessage = `${res.status} - DELETE with account ${account}, URL "${subscription.id}" failed: ${bodyError}`;
        console.error(errorMessage);
        return;
      } else {
        //nothing to do
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        console.error(
          `Notification subscription delete took longer than ${fetchTimeoutMs} ms: aborted`
        );
        return;
      }
      console.error(e);
    }
  }
}
