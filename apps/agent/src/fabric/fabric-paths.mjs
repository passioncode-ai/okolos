// Where a service's things live (fabric-service/0.1): the services directory, its data, config, logs and run dirs per OS, private dirs, atomic writes.
// Part of the Node service kit (FAA-65, layer L1); the twin of fabric_paths.py. Node 20+, no dependency.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ID, INSTANCE, ServiceError, expand } from './fabric-base.mjs';
import { windowsProtect } from './fabric-platform.mjs';

// DEC-0032: LOCALAPPDATA, not APPDATA, so token files never roam with the profile.
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

export function servicesDir(platform = process.platform) {
  if (process.env.FABRIC_SERVICES_DIR) return expand(process.env.FABRIC_SERVICES_DIR);
  const home = os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/ai.passioncode.fabric/services');
  if (platform === 'win32') return path.join(localAppData(), 'passioncode-fabric', 'services');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'passioncode-fabric/services');
}

export function serviceDirs(id, platform = process.platform) {
  if (!ID.test(id)) throw new ServiceError(`Service id ${id} must match ${ID}.`);
  const home = os.homedir();
  if (platform === 'darwin') {
    return {
      data: path.join(home, 'Library/Application Support', id),
      logs: path.join(home, 'Library/Logs', id),
      cache: path.join(home, 'Library/Caches', id),
    };
  }
  if (platform === 'win32') {
    const data = path.join(localAppData(), id);
    return { data, logs: path.join(data, 'Logs'), cache: path.join(data, 'Cache') };
  }
  return {
    data: path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), id),
    logs: path.join(process.env.XDG_STATE_HOME || path.join(home, '.local/state'), id, 'logs'),
    cache: path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), id),
  };
}

/**
 * One instance's folders (FAA-125, brief D16): `default` keeps serviceDirs (an existing install keeps its data, logs
 * and lock); any other is a sibling named as its descriptor, `<id>.<instance>`, never inside the default tree.
 */
export function instanceDirs(id, instance = 'default', platform = process.platform) {
  const personal = serviceDirs(id, platform);
  if (typeof instance !== 'string' || !INSTANCE.test(instance)) throw new ServiceError(`Instance ${JSON.stringify(instance)} must match ${INSTANCE}.`);
  if (instance === 'default') return personal;
  const folder = `${id}.${instance}`;
  if (platform === 'win32') {
    const data = path.join(path.dirname(personal.data), folder);
    return { data, logs: path.join(data, 'Logs'), cache: path.join(data, 'Cache') };
  }
  if (platform === 'darwin') return Object.fromEntries(Object.entries(personal).map(([key, dir]) => [key, path.join(path.dirname(dir), folder)]));
  return {
    data: path.join(path.dirname(personal.data), folder),
    logs: path.join(path.dirname(path.dirname(personal.logs)), folder, 'logs'),
    cache: path.join(path.dirname(personal.cache), folder),
  };
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') windowsProtect(dir, { folder: true });
  else fs.chmodSync(dir, 0o700);
  return dir;
}

export function atomicWrite(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    try {
      // On Windows the file's ACL is its privacy (DEC-0032): set explicitly and protected — before the bytes go in —
      // so it does not depend on what the folder hands down. A rename keeps it.
      if (process.platform === 'win32') windowsProtect(tmp, { folder: false });
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== 'win32') fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    // Whatever failed, no half-written file is left beside the real one, and a failed cleanup never replaces the
    // error that caused it (FAA-85).
    try { fs.rmSync(tmp, { force: true }); } catch { /* the original error is the one to report */ }
    throw error;
  }
}
