import { OutboundMessageStream } from "@/bus/bus";

export type ChannelName = "http" | "telegram";

export interface Channel {
  readonly name: ChannelName;
  start(): Promise<void>;
  stop(): Promise<void>;
  createReplyStream(chatId: string): Promise<OutboundMessageStream>;
}
