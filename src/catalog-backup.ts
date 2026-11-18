import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';

export type BackupFn = (text: string) => Promise<void>;

// Uploads each snapshot under a timestamped name and keeps a "latest" copy.
export function createBlobBackup(
  accountUrl: string,
  container: string,
  now: () => Date = () => new Date(),
  credential: TokenCredential = new DefaultAzureCredential(),
): BackupFn {
  const containerClient = new BlobServiceClient(accountUrl, credential).getContainerClient(container);
  return async (text) => {
    await containerClient.createIfNotExists();
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const body = Buffer.from(text, 'utf8');
    await containerClient.getBlockBlobClient(`history/${stamp}.json`).uploadData(body, { blobHTTPHeaders: { blobContentType: 'application/json' } });
    await containerClient.getBlockBlobClient('latest.json').uploadData(body, { blobHTTPHeaders: { blobContentType: 'application/json' } });
  };
}

// A burst of edits shares one snapshot taken before the first of them.
export function throttleBackup(backup: BackupFn, minGapMs: number, now: () => number = Date.now): BackupFn {
  let last = Number.NEGATIVE_INFINITY;
  return async (text) => {
    if (now() - last < minGapMs) return;
    await backup(text);
    last = now();
  };
}
