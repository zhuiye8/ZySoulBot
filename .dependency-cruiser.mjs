// 依赖巡航：强制架构边界 + 严格零循环依赖。
export default {
  forbidden: [
    {
      name: 'soul-shared-no-outside',
      comment: 'soul/shared 严禁依赖 llm/tools/transport/admin/storage/app（纯领域核心）',
      severity: 'error',
      from: { path: '^src/(soul|shared)' },
      to: { path: '^src/(llm|tools|transport|admin|storage|app\\.ts|rhythm\\.ts|start\\.ts)' },
    },
    {
      name: 'soul-shared-no-builtin-io',
      comment: 'P1-ARCH-01：soul/shared 严禁直接导入 Node 内置文件系统/网络/子进程/数据库 I/O 模块',
      severity: 'error',
      from: { path: '^src/(soul|shared)' },
      to: {
        dependencyTypes: ['core'],
        path: '^(node:)?(fs|fs/promises|child_process|http|https|http2|net|tls|dns|dgram|sqlite|worker_threads)$',
      },
    },
    {
      name: 'no-circular',
      comment: '严格禁止循环依赖（0 容忍）',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.json'] },
    includeOnly: '^src',
  },
}
