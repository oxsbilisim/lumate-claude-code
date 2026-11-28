// Files for lumate_request: the proxy reads them from the project folder (and nowhere else) and uploads each to Lumate, then the tool call
// carries the ids Lumate gave back instead of the paths. Node 18+, no dependencies. Used by mcp-proxy.js; tested on its own.
//
// What is read: only regular files whose real path is inside the real path of the project folder (a link in the path, or as the file
// itself, is followed only if it still ends inside; a link AS the file is refused), at most 10 files of 25 MB, never a file with a secret-like
// name in any segment (the same list as hooks' guard.sh, which a test compares). The path itself is never sent: only the file's own name.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024;

// The names that hold secrets: one path segment, lower-cased. Keep in step with secret_name() in guard.sh (test/request-files.test.js compares them).
const SECRET_GLOBS = ['.env*', '*.env', '*.env.*', '.lumate*', '*.pem', '*.key', '*.p12', '*.keystore', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  '.npmrc', '.netrc', '.pypirc', 'credentials*', 'secrets*', 'service_account*.json', '.git', '.ssh', '.aws'];
const globToRegExp = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const SECRET_RES = SECRET_GLOBS.map(globToRegExp);
const isSecretName = (segment) => { const s = String(segment).toLowerCase(); return SECRET_RES.some((re) => re.test(s)); };
const hasSecretSegment = (p) => String(p).split(/[\\/:]+/).some((seg) => seg && isSecretName(seg));

class Refused extends Error {}

const lower = (p) => p.toLowerCase(); // as guard.sh: a case-insensitive file system must not let a differently written path escape the check

// One file: the checked absolute path and its stat, or throws Refused with a sentence for the developer.
function check(root, rootReal, given) {
  if (typeof given !== 'string' || !given.trim() || given.includes('\0')) throw new Refused('A file path is empty or not plain text.');
  const abs = path.resolve(root, given);
  let st;
  try { st = fs.lstatSync(abs); } catch { throw new Refused(`${path.basename(given)} was not found in the project folder.`); }
  if (st.isSymbolicLink()) throw new Refused(`${path.basename(given)} is a link: links are not followed. Give the real file inside the project.`);
  if (!st.isFile()) throw new Refused(`${path.basename(given)} is not a regular file.`);
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new Refused(`${path.basename(given)} could not be resolved.`); }
  const prefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
  if (!lower(real).startsWith(lower(prefix))) throw new Refused(`${path.basename(given)} is outside the project folder: only files inside it are sent.`);
  if (hasSecretSegment(real.slice(prefix.length))) throw new Refused(`${path.basename(given)} looks like a secret file (or is in a folder that does): it is not sent.`);
  if (st.size === 0) throw new Refused(`${path.basename(given)} is empty.`);
  if (st.size > MAX_BYTES) throw new Refused(`${path.basename(given)} is larger than 25 MB.`);
  return { real, st };
}

// The project folder's real path, or throws Refused (no folder, the root of the disk, or the home folder itself).
function rootOf(projectDir) {
  let rootReal;
  try { rootReal = fs.realpathSync(projectDir); } catch { throw new Refused('The project folder could not be found, so no file was sent.'); }
  if (rootReal === path.parse(rootReal).root || rootReal === fs.realpathSync(os.homedir())) throw new Refused('The project folder is the root of the disk or your home folder: no file was sent from there.');
  return rootReal;
}

// Reads the checked file through one open handle (no link followed, and the handle must be the very file that was checked).
function read({ real, st }) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(real, flags);
  try {
    const now = fs.fstatSync(fd);
    if (!now.isFile() || now.dev !== st.dev || now.ino !== st.ino) throw new Refused(`${path.basename(real)} changed while it was read; try again.`);
    if (now.size > MAX_BYTES) throw new Refused(`${path.basename(real)} is larger than 25 MB.`);
    const buf = Buffer.alloc(now.size);
    let got = 0;
    while (got < now.size) { const n = fs.readSync(fd, buf, got, now.size - got, got); if (n === 0) break; got += n; }
    return buf.subarray(0, got);
  } finally { fs.closeSync(fd); }
}

// Everything checked first (nothing is uploaded when one file is refused), then read: [{name, data}]. Throws Refused.
function prepare(projectDir, paths) {
  if (!Array.isArray(paths)) throw new Refused('files must be a list of paths inside the project folder.');
  const list = [...new Set(paths)];
  if (list.length > MAX_FILES) throw new Refused(`At most ${MAX_FILES} files in one request.`);
  const rootReal = rootOf(projectDir);
  const checked = list.map((p) => check(projectDir, rootReal, p));
  return checked.map((c) => ({ name: path.basename(c.real), data: read(c) }));
}

module.exports = { prepare, check, rootOf, isSecretName, hasSecretSegment, SECRET_GLOBS, MAX_FILES, MAX_BYTES, Refused };
