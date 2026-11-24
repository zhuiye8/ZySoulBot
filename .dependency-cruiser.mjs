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
