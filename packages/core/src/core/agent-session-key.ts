import { subagentSessionKey as nestedSubagentKey } from "@rome-os/app-runtime";
import { v4 as uuidv4 } from "uuid";

// Core's key builders. The key grammar and its parser live in the app SDK
// (`@rome-os/app-runtime`), so apps and core spell keys the same way.

export {
  forkSessionKey,
  parseSessionKey,
  sessionKeyChannel,
  webchatConversationOfKey,
  webchatSessionKey,
  type ParsedSessionKey,
} from "@rome-os/app-runtime";

/** A fresh subagent's key, nested under its parent's so it never reuses the
 *  parent's provider context. */
export function subagentSessionKey(parentKey: string): string {
  return nestedSubagentKey(parentKey, uuidv4());
}

/** A one-off key for a run that names no conversation. */
export function adhocSessionKey(agentName: string): string {
  return `${agentName}:${uuidv4()}`;
}
