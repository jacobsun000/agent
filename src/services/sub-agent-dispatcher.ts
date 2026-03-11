import { type Bus } from "@/bus/bus";
import { Agent, type SubAgentRequest } from "@/core/agent";
import { type Config } from "@/utils/config";
import { createLanguageModel } from "@/utils/model";

type SubAgentDispatcherConfig = {
  bus: Bus;
  config: Config;
};

export function createSubAgentDispatcher(config: SubAgentDispatcherConfig) {
  return async (request: SubAgentRequest) => {
    const model = createLanguageModel(config.config, config.config.agent.model);
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
