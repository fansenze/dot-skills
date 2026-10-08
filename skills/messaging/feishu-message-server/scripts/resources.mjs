/** Authorized host-local files only. No payload bytes enter the resident JSON API. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SafeError} from './config.mjs';

export const RESOURCE_LIMITS = Object.freeze({image:10 * 1024 * 1024, file:30 * 1024 * 1024});
const fail = () => { throw new SafeError('Invalid attachment: require a nonempty supported regular file inside the authorized root'); };
export function readUploadFile({filePath, allowedRoot, kind, sha256, size, name, file_type}) {
  if (!RESOURCE_LIMITS[kind] || !path.isAbsolute(filePath ?? '') || !path.isAbsolute(allowedRoot ?? '')) fail();
  let bytes, filename;
  try {
    const root = fs.realpathSync(allowedRoot), resolved = fs.realpathSync(filePath), rel = path.relative(root, resolved);
    if (!fs.statSync(root).isDirectory() || !rel || rel === '..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) fail();
    // Reject a leaf symlink and recheck the resolved path through the opened descriptor.
    if (fs.lstatSync(filePath).isSymbolicLink()) fail();
    const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd), current = fs.statSync(fs.realpathSync(filePath));
      if (!before.isFile() || before.nlink !== 1 || before.dev !== current.dev || before.ino !== current.ino || before.size < 1 || before.size > RESOURCE_LIMITS[kind] || fs.realpathSync(filePath) !== resolved) fail();
      // A bounded read prevents a concurrently growing file from defeating the size limit.
      bytes = Buffer.alloc(before.size + 1); let offset = 0, n;
      while (offset < bytes.length && (n = fs.readSync(fd, bytes, offset, bytes.length-offset, null))) offset += n;
      const after = fs.fstatSync(fd);
      const final = fs.statSync(filePath);
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || fs.realpathSync(allowedRoot)!==root || fs.realpathSync(filePath)!==resolved || final.dev!==before.dev || final.ino!==before.ino) fail();
      bytes = bytes.subarray(0, offset);
    } finally { fs.closeSync(fd); }
    filename = path.basename(resolved);
  } catch { fail(); }
  if (!filename.isWellFormed() || filename.length > 255 || /[\x00-\x1f\x7f]/.test(filename)) fail();
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (kind === 'image' && !['jpg','jpeg','png','webp','gif','bmp','ico','tiff','tif','heic'].includes(extension)) fail();
  // File messages initially support PDF only; do not silently send other document types.
  if (kind === 'file' && (extension !== 'pdf' || bytes.subarray(0,5).toString('ascii') !== '%PDF-')) fail();
  const descriptor = {filePath,allowedRoot,kind,name:filename,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),...(kind === 'file' ? {file_type:'pdf'} : {})};
  if ((sha256 !== undefined && sha256 !== descriptor.sha256) || (size !== undefined && size !== descriptor.size) || (name !== undefined && name !== filename) || (file_type !== undefined && file_type !== descriptor.file_type)) fail();
  return {descriptor,bytes};
}
export const describeUpload = input => readUploadFile(input).descriptor;
