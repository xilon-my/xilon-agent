import type { PermissionMode } from "./types.js";

export interface PermissionRequest {
  toolName: string;
  summary: string;
  command?: string;
}

export interface PermissionRuntime {
  mode: PermissionMode;
  requestApproval?: (request: PermissionRequest) => Promise<boolean>;
}

const ALWAYS_ALLOW_TOOLS = new Set([
  "get_cwd",
  "list_drives",
  "list_files",
  "read_file",
  "send_local_file",
  "glob_search",
  "grep_files",
  "list_memories",
  "list_sessions",
  "resume_session",
]);

export async function requireToolPermission(
  runtime: PermissionRuntime | undefined,
  request: PermissionRequest,
): Promise<void> {
  if (ALWAYS_ALLOW_TOOLS.has(request.toolName)) {
    return;
  }

  const mode = runtime?.mode ?? "ask";
  if (mode === "allow") {
    return;
  }

  if (mode === "deny") {
    throw new Error(`权限策略拒绝执行 ${request.toolName}`);
  }

  const approved = await runtime?.requestApproval?.(request);
  if (!approved) {
    throw new Error(`用户拒绝执行 ${request.toolName}`);
  }
}
