import { type Bus } from "@/bus";
import { type SubAgentRequest } from "@/core/agent";
import { getSystemPrompt } from "@/core/prompt";
import { SubAgent } from "@/core/sub-agent";
import { type Config } from "@/utils/config";
import { subAgentModel } from "@/utils/model";

type SubAgentDispatcherConfig = {
  bus: Bus;
  config: Config;
};

export function createSubAgentDispatcher(config: SubAgentDispatcherConfig) {
  return async (request: SubAgentRequest) => {
    const subAgent = new SubAgent({
      model: subAgentModel,
      systemPrompt: await getSystemPrompt('sub_agent'),
    });
    const response = await subAgent.runTurn(request.task);
    await config.bus.dispatchSubAgentResult({
      ...request,
      response
    });
  };
}
