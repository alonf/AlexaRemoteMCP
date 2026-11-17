import AlexaRemote from 'alexa-remote2';

type WriteCallback = (error: Error | null, body?: unknown) => void;

export type WriteResponse =
  | { status: 'not_dispatched' }
  | { status: 'unknown' }
  | { status: 'rate_limited' }
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
        if (process.env.ALEXA_DIAG === '1') {
          const raw = error ? `error: ${error.message}` : `body: ${JSON.stringify(body)}`;
          console.log(`Alexa write result: ${raw.replace(/[A-Za-z0-9_\-.]{24,}/g, '<id>').slice(0, 500)}`);
        }
        if (error) resolve(/status=429\b/.test(error.message) ? { status: 'rate_limited' } : { status: 'unknown' });
        else resolve({ status: 'response_received', body });
      });
    } catch {
      resolve({ status: 'unknown' });
    }
  });
}
