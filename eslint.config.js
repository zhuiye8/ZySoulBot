// eslint：TS 解析 + 统一代码风格 + 架构边界与禁 as never 铁律。
import stylistic from '@stylistic/eslint-plugin'
import tseslint from 'typescript-eslint'

const STYLE = {
  '@stylistic/semi': ['error', 'never'],
  '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
  '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
  '@stylistic/comma-dangle': ['error', 'always-multiline'],
  '@stylistic/no-trailing-spaces': 'error',
  '@stylistic/eol-last': ['error', 'always'],
  '@stylistic/object-curly-spacing': ['error', 'always'],
  '@stylistic/arrow-parens': ['error', 'always'],
  '@stylistic/space-before-function-paren': ['error', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
}

export default tseslint.config(
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2024, sourceType: 'module' },
    plugins: { '@typescript-eslint': tseslint.plugin, '@stylistic': stylistic },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', {
        selector: 'TSAsExpression[typeAnnotation.type="TSNeverKeyword"]',
        message: '禁止使用 as never 绕过类型检查（必须修齐契约类型）',
      }],
      ...STYLE,
    },
  },
  {
    files: ['eslint.config.js', '.dependency-cruiser.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    plugins: { '@stylistic': stylistic },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], ...STYLE },
  },
  {
    files: ['src/soul/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/llm/**', '**/tools/**', '**/transport/**', '**/admin/**', '**/storage/**'], message: 'soul/shared 严禁依赖外部适配器、存储实现、平台或后台' },
          { group: ['hono', 'hono/*', '@hono/*', 'ws', 'node:sqlite'], message: 'soul/shared 严禁直接依赖框架或具体数据库驱动' },
        ],
      }],
    },
  },
)
