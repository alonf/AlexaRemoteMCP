import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const windowsAcl = `
$ErrorActionPreference = 'Stop'
$path = $env:ALEXA_STORE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:ALEXA_STORE_CREATE -eq '1') {
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
  $security.AddAccessRule($rule)
  (New-Object System.IO.DirectoryInfo($path)).Create($security)
}
$item = Get-Item -LiteralPath $path -Force
$security = $item.GetAccessControl()
if ($security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected owner' }
if ($item.PSIsContainer -and -not $security.AreAccessRulesProtected) { throw 'Inherited directory ACL' }
$rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -eq 0) { throw 'No access rules' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected access rule' }
}
`;

async function checkWindowsAcl(target: string, create = false): Promise<void> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('Windows system directory unavailable');
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', windowsAcl], {
    env: { ...process.env, ALEXA_STORE_PATH: target, ALEXA_STORE_CREATE: create ? '1' : '0' },
    timeout: 10000,
    windowsHide: true,
  });
}

async function checkPrivate(target: string, directory: boolean): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('Invalid credential store entry');
  }
  if (process.platform === 'win32') {
    await checkWindowsAcl(target);
  } else {
    const uid = process.getuid?.();
    const required = directory ? 0o700 : 0o600;
    if (uid === undefined || stat.uid !== uid || (stat.mode & 0o777) !== required) {
      throw new Error('Credential store permissions are not owner-only');
    }
  }
}

async function assertOutsideRepository(directory: string): Promise<void> {
  let current = directory;
  for (;;) {
    try {
      await fs.lstat(path.join(current, '.git'));
      throw new Error('Credential store must be outside a repository');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export class CredentialStore {
  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<CredentialStore> {
    try {
      const absolute = path.resolve(directory);
      const parent = await fs.realpath(path.dirname(absolute));
      const canonical = path.join(parent, path.basename(absolute));
      await assertOutsideRepository(canonical);
      try {
        await fs.lstat(canonical);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (process.platform === 'win32') await checkWindowsAcl(canonical, true);
        else await fs.mkdir(canonical, { mode: 0o700 });
      }
      await checkPrivate(canonical, true);
      return new CredentialStore(canonical);
    } catch {
      throw new Error('Cannot open protected credential store');
    }
  }

  async load(): Promise<unknown | null> {
    try {
      await checkPrivate(this.directory, true);
      const file = path.join(this.directory, 'session.json');
      try {
        await checkPrivate(file, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch {
      throw new Error('Cannot read protected credential store');
    }
  }

  async save(data: unknown): Promise<void> {
    const file = path.join(this.directory, 'session.json');
    const temp = path.join(this.directory, `session-${randomUUID()}.tmp`);
    let tempCreated = false;
    try {
      await checkPrivate(this.directory, true);
      try {
        await checkPrivate(file, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const contents = JSON.stringify(data);
      if (contents === undefined) throw new Error('Invalid session');
      const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      tempCreated = true;
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await checkPrivate(temp, false);
      await fs.rename(temp, file);
      tempCreated = false;
    } catch {
      throw new Error('Cannot persist protected credentials');
    } finally {
      if (tempCreated) await fs.unlink(temp).catch(() => undefined);
    }
  }

  async remove(): Promise<void> {
    try {
      await checkPrivate(this.directory, true);
      const file = path.join(this.directory, 'session.json');
      try {
        await checkPrivate(file, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      await fs.unlink(file);
    } catch {
      throw new Error('Cannot remove protected credentials');
    }
  }
}
