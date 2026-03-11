import { OutboundMessageStream } from "@/bus/bus";

export type ChannelName = "http" | "telegram";

export type OutboundAttachment = {
  path: string;
  filename?: string;
  caption?: string;
};

export interface Channel {
  readonly name: ChannelName;
  start(): Promise<void>;
  stop(): Promise<void>;
  createReplyStream(chatId: string): Promise<OutboundMessageStream>;
  sendAttachment(chatId: string, attachment: OutboundAttachment): Promise<void>;
}
