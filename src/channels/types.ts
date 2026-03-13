import { OutboundMessageStream, OutboundAttachment } from "@/bus";

export type ChannelName = "http" | "telegram";


export interface Channel {
  readonly name: ChannelName;
  start(): Promise<void>;
  stop(): Promise<void>;
  createReplyStream(chatId: string): Promise<OutboundMessageStream>;
  sendAttachment(chatId: string, attachment: OutboundAttachment): Promise<void>;
}
