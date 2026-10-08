// Demo session capability for the agent API (POST /session). The token is
// kept in this process's memory only and sent as an Authorization header.
export async function agentSession(agentUrl) {
  const response = await fetch(`${agentUrl}/session`, { method: "POST", signal: AbortSignal.timeout(15_000) });
  if (response.status !== 201) throw new Error(`agent session could not be created: HTTP ${response.status}`);
  const { token } = await response.json();
  return { authorization: `Bearer ${token}` };
}
