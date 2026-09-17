import { createHash } from 'node:crypto'
import { readFile, readdir, lstat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const MAX_FILES = 5_000, MAX_BYTES = 50 * 1024 * 1024, MAX_FILE = 256 * 1024
const blocked = /(?:^|\/)(?:\.git|\.swico|node_modules|dist|build)(?:\/|$)|(?:^|\/)\.env(?:$|[./])|(?:^|\/)(?:\.npmrc|\.pypirc|credentials?|secrets?|tokens?)(?:\/|$)|\.(?:pem|key|p12|pfx|kdbx)$/i

export type CloudSnapshotFile = { path: string; data_base64: string; sha256: string }
export type CloudSnapshot = { version: 1; file_count: number; total_bytes: number; files: CloudSnapshotFile[] }

function safePath(root: string, path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || blocked.test(normalized)) throw new Error('Cloud snapshot path is outside the allowed workspace.')
  return join(root, ...normalized.split('/'))
}

export async function createCloudSnapshot(root: string): Promise<CloudSnapshot> {
  const files: CloudSnapshotFile[] = [], base = root
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = join(directory, entry.name), rel = relative(base, candidate).replaceAll('\\', '/')
      if (blocked.test(rel) || entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { await walk(candidate); continue }
      if (!entry.isFile()) continue
      if (files.length >= MAX_FILES) throw new Error('Cloud snapshot contains too many files.')
      const info = await lstat(candidate)
      if (!info.isFile() || info.size > MAX_FILE) continue
      const data = await readFile(safePath(base, rel))
      if (data.includes(0)) continue
      files.push({ path: rel, data_base64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex') })
      if (files.reduce((total, item) => total + Buffer.byteLength(item.data_base64, 'base64'), 0) > MAX_BYTES) throw new Error('Cloud snapshot exceeds the supported size.')
    }
  }
  await walk(base)
  return { version: 1, file_count: files.length, total_bytes: files.reduce((total, item) => total + Buffer.byteLength(item.data_base64, 'base64'), 0), files }
}
