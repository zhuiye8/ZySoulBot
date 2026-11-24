import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSoulStore } from '../../src/storage/sqlite-store.ts'
import { CredentialStore } from '../../src/storage/credentials-store.ts'
import { InMemoryToolRegistry } from '../../src/tools/registry.ts'
import { isDangerousCommand, registerWorkspaceTools, safeResolveInWorkspace } from '../../src/tools/workspace.ts'

describe('Workspace sandbox, self-verifying skills, and credential tools', () => {
  it('blocks path traversal and dangerous commands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-ws-'))
    try {
      assert.equal(safeResolveInWorkspace(dir, '../escape.txt'), null)
      assert.ok(safeResolveInWorkspace(dir, 'skills/demo/SKILL.md'))
      assert.equal(isDangerousCommand('rm -rf /'), true)
      assert.equal(isDangerousCommand('sudo systemctl stop zhuiyebot'), true)
      assert.equal(isDangerousCommand('node -e "console.log(1)"'), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes files, self-verifies a skill, injects ZYSOUL_CREDENTIALS, and never leaks secret text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zysoul-ws-run-'))
    const store = new SqliteSoulStore(':memory:')
    const credentials = new CredentialStore(join(dir, 'credentials.json'))
    const requested: string[] = []
    try {
      const reg = new InMemoryToolRegistry()
      registerWorkspaceTools(reg, {
        workspaceDir: join(dir, 'workspace'),
        store,
        credentials,
        allowUnsafeLocalExec: true,
        injectCredentialsPath: true,
        onCredentialRequested: (name) => requested.push(name),
      })
      const ctx = { botId: 'nahida', threadKey: 'solo:1', userId: '1', userName: '追夜', isGroup: false, solo: true, now: new Date() }

      // 1) 登记凭证 + 管理员填写 + read_credential 不泄露明文密钥
      await reg.get('request_credential')!.execute({
        name: 'image-gen',
        label: '生图服务',
        provider: 'aliyun-wanx',
        fields: [{ key: 'apiKey', label: 'API Key', type: 'secret', required: true }],
      }, ctx)
      assert.deepEqual(requested, ['image-gen'])
      credentials.fill('image-gen', { apiKey: 'SUPER_SECRET_KEY_12345' })

      const readCred = await reg.get('read_credential')!.execute({ name: 'image-gen' }, ctx)
      assert.match(readCred.output, /已就绪/)
      assert.ok(!readCred.output.includes('SUPER_SECRET_KEY_12345'), 'secret must never leak into LLM tool output')

      // 2) 写 SKILL.md + 脚本，并验证 register_skill 自检与 ZYSOUL_CREDENTIALS 环境变量注入
      await reg.get('workspace_write')!.execute({
        path: 'skills/hello-skill/SKILL.md',
        content: '# hello-skill\n打印问候并检查凭证路径。',
      }, ctx)
      await reg.get('workspace_write')!.execute({
        path: 'skills/hello-skill/check.mjs',
        content: 'import fs from "node:fs"; const p = process.env.ZYSOUL_CREDENTIALS; if (!p || !fs.existsSync(p)) process.exit(2); console.log("ok");',
      }, ctx)

      // 自检失败时不应登记
      const badReg = await reg.get('register_skill')!.execute({
        name: 'hello-skill',
        summary: '测试技能',
        verifyCommand: 'node -e "process.exit(1)"',
      }, ctx)
      assert.equal(badReg.isError, true)
      assert.equal(store.listCapabilities().length, 0)

      // 自检通过 → 登记进 capabilities 表
      const okReg = await reg.get('register_skill')!.execute({
        name: 'hello-skill',
        summary: '测试技能',
        verifyCommand: 'node check.mjs',
      }, ctx)
      assert.equal(okReg.isError, undefined)
      const caps = store.listCapabilities()
      assert.equal(caps.length, 1)
      assert.equal(caps[0]!.name, 'hello-skill')
    } finally {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
