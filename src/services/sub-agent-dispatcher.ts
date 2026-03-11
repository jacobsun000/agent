import { createOpenAI } from "@ai-sdk/openai";

import { type Bus } from "@/bus/bus";
import { Agent, type SubAgentRequest } from "@/core/agent";
import { type Config, getProviderConfig } from "@/utils/config";

type SubAgentDispatcherConfig = {
  bus: Bus;
  config: Config;
};

export function createSubAgentDispatcher(config: SubAgentDispatcherConfig) {
  return async (request: SubAgentRequest) => {
    const provider = getProviderConfig(config.config);
    const openai = createOpenAI({ apiKey: provider.apiKey });
    const model = openai(config.config.agent.model);
    const subAgent = new Agent({
      model,
      mode: "sub_agent",
      onSubAgentSpawn: createSubAgentDispatcher(config)
    });
    const subAgentContextId = `${request.contextId ?? `${request.channel}:${request.chatId}`}:sub-agent:${request.label}:${Date.now()}`;
    const response = await subAgent.runTurn({
      channel: request.channel,
      chatId: request.chatId,
      contextId: subAgentContextId,
      text: request.task
    });

    await config.bus.dispatchSubAgentResult({
      ...request,
      response
    });
  };
}
