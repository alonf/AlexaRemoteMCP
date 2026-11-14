export const REQUIRED_AUTH_GUARD_VERSION = 1;

export function assertAuthGuard(library: { connectivityProofAuthGuardVersion?: number }): void {
  if (library.connectivityProofAuthGuardVersion !== REQUIRED_AUTH_GUARD_VERSION) {
    throw new Error('Required upstream authentication guard is missing');
  }
}

export function guardedOptions<T extends object>(
  library: { connectivityProofAuthGuardVersion?: number },
  options: T,
): T & { proofNoImplicitAuth: true; cookieRefreshInterval: 0 } {
  assertAuthGuard(library);
  return { ...options, proofNoImplicitAuth: true, cookieRefreshInterval: 0 };
}
