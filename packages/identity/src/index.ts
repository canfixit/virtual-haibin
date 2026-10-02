export type AgentIdentity = {
  id: string;
  owner: string;
  walletAddress?: string;
  network?: string;
};

export function createAgentIdentity(identity: AgentIdentity): AgentIdentity {
  return { ...identity };
}

export { loadOrCreateSigningKey, publishPublicKey, readOrCreatePrivateFile } from "./key-file.js";
export type { PersistentSigningKey } from "./key-file.js";
