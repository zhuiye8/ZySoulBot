// 外部服务凭证文件存储适配器（0600 权限收紧 + 排他唯一临时文件原子写，I/O 隔离在 storage 层）。
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CredentialStore } from '../soul/governance/credentials.ts'
import type { CredentialFileBackend } from '../soul/governance/credentials.ts'

function tightenPermissions(filePath: string): void {
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Windows 忽略 chmod
  }
}

export function createFileCredentialBackend(filePath: string): CredentialFileBackend {
  // P2-CRED-01：启动时立即检查并收紧已有凭证文件权限
  if (existsSync(filePath)) {
    tightenPermissions(filePath)
  }
  return {
    path: filePath,
    readText(): string | null {
      if (!existsSync(filePath)) return null
      return readFileSync(filePath, 'utf8')
    },
    writeText(content: string): void {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      tightenPermissions(tmp)
      renameSync(tmp, filePath)
      tightenPermissions(filePath)
    },
  }
}

export class FileCredentialStore extends CredentialStore {
  constructor(filePath: string) {
    super(createFileCredentialBackend(filePath))
  }
}

export { FileCredentialStore as CredentialStore }
