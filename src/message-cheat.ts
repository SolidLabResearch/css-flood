#!/usr/bin/env node

import { AnyFetchType, es6fetch } from "./generic-fetch.js";
import { ControllerMsg } from "./css-flood-messages.js";

interface Message<MsgType> {
  message: MsgType;
  context: any;
}

export class MessageCheat<MsgType> {
  messages: Message<MsgType>[];
  buffer: SharedArrayBuffer;
  messageCount: Int32Array;

  constructor() {
    this.messages = [];
    this.buffer = new SharedArrayBuffer(4);
    this.messageCount = new Int32Array(this.buffer);
    this.messageCount[0] = 0;
    process.on("message", (message: MsgType) => {});
  }

  messageCallback(message: MsgType, context: any = null): void {
    this.messages.push({ message, context });
    Atomics.add(this.messageCount, 0, 1);
    Atomics.notify(this.messageCount, 0);
  }

  async waitForMessage(): Promise<Message<MsgType>> {
    while (true) {
      // @ts-ignore
      const aw = Atomics.waitAsync(this.messageCount, 0, 0, 1000);
      if (aw.async) {
        await aw.value;
      }
      if (this.messages.length === 0) {
        continue;
      }
      const message = this.messages.shift();
      Atomics.sub(this.messageCount, 0, 1);
      if (!message) {
        throw new Error("Message Queue error");
      }
      return message;
    }
  }
}
