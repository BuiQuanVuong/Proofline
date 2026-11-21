// ECS task scale-in protection. While a runner works on a
// shard it marks itself protected, so step scaling lowering the desired count
// never stops a task mid-shard; ECS stops it once protection is released.
// Outside ECS (local runs) there's no agent endpoint and this is a no-op.

const AGENT = process.env.ECS_AGENT_URI;
const EXPIRES_MIN = 30; // safety net if the runner dies without releasing

/**
 * Returns "granted", "unavailable: <reason>" or "not on ECS". Callers log the
 * result, so every shard log records whether the shard was protected.
 */
export async function setScaleInProtection(enabled) {
  if (!AGENT) return "not on ECS";
  try {
    const res = await fetch(`${AGENT}/task-protection/v1/state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enabled ? { ProtectionEnabled: true, ExpiresInMinutes: EXPIRES_MIN } : { ProtectionEnabled: false }),
    });
    if (res.ok) return "granted";
    return `unavailable: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
  } catch (err) {
    return `unavailable: ${err.message}`;
  }
}
