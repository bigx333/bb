import { getEnvironment, getHost } from "@bb/db";
import { clampPermissionModeToCeiling, type PermissionMode } from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";

type PermissionCeilingDeps = Pick<AppDeps, "db">;

interface ClampPermissionModeToHostArgs {
  hostId: string | null;
  permissionMode: PermissionMode;
  providerId?: string;
}

interface ClampPermissionModeToParentThreadArgs {
  ceiling: PermissionMode;
  permissionMode: PermissionMode;
  permissionModes?: readonly PermissionMode[];
  providerId: string;
}

class PermissionCeilingConflictError extends ApiError {}

export function isPermissionCeilingConflictError(
  error: unknown,
): error is PermissionCeilingConflictError {
  return error instanceof PermissionCeilingConflictError;
}

export function getHostPermissionCeiling(
  deps: PermissionCeilingDeps,
  hostId: string | null,
): PermissionMode {
  if (hostId === null) return "full";
  return getHost(deps.db, hostId)?.maxPermissionMode ?? "full";
}

export function resolveEnvironmentHostId(
  deps: PermissionCeilingDeps,
  environmentId: string | null,
): string | null {
  if (environmentId === null) return null;
  return getEnvironment(deps.db, environmentId)?.hostId ?? null;
}

export function clampPermissionModeToHost(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: ClampPermissionModeToHostArgs,
): PermissionMode {
  const ceiling = getHostPermissionCeiling(deps, args.hostId);
  const supported = args.providerId
    ? deps.providerRegistry.getSupportedPermissionModes(args.providerId)
    : null;
  const clamped = clampPermissionModeToCeiling({
    ceiling,
    permissionMode: args.permissionMode,
    ...(supported ? { permissionModes: supported } : {}),
  });
  if (clamped === null) {
    throw new PermissionCeilingConflictError(
      400,
      "host_permission_ceiling_conflict",
      `This machine limits permission mode to ${ceiling}, and provider ${args.providerId} requires a higher mode.`,
    );
  }
  return clamped;
}

export function clampPermissionModeToParentThread(
  args: ClampPermissionModeToParentThreadArgs,
): PermissionMode {
  const clamped = clampPermissionModeToCeiling({
    ceiling: args.ceiling,
    permissionMode: args.permissionMode,
    ...(args.permissionModes ? { permissionModes: args.permissionModes } : {}),
  });
  if (clamped === null) {
    throw new PermissionCeilingConflictError(
      400,
      "parent_permission_ceiling_conflict",
      `This thread's parent limits permission mode to ${args.ceiling}, and provider ${args.providerId} requires a higher mode.`,
    );
  }
  return clamped;
}
