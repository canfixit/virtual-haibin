export type AgentIdentity = {
  id: string;
  owner: string;
  walletAddress?: string;
  network?: string;
};

export function createAgentIdentity(identity: AgentIdentity): AgentIdentity {
  return { ...identity };
}
