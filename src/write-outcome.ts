import AlexaRemote from 'alexa-remote2';

type WriteCallback = (error: Error | null, body?: unknown) => void;

export type WriteResponse =
  | { status: 'not_dispatched' }
  | { status: 'unknown' }
  | { status: 'response_received'; body: unknown };

export function awaitWriteResponse(
  dispatch: (callback: WriteCallback) => void,
): Promise<WriteResponse> {
  const patched = AlexaRemote as unknown as { connectivityProofPatchVersion?: number };
  if (patched.connectivityProofPatchVersion !== 1) {
    return Promise.resolve({ status: 'not_dispatched' });
  }
  return new Promise((resolve) => {
    try {
      dispatch((error, body) => {
        resolve(error ? { status: 'unknown' } : { status: 'response_received', body });
      });
    } catch {
      resolve({ status: 'unknown' });
    }
  });
}
