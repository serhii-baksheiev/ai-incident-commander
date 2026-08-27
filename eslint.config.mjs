import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['packages/domain/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  plugins: {
    '@typescript-eslint': tseslint.plugin,
  },
  rules: {
    'no-eval': 'error',
    'no-new-func': 'error',
    'no-implied-eval': 'error',
    '@typescript-eslint/no-require-imports': 'error',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'module',
            message: 'The domain layer cannot create dynamic CommonJS loaders.',
          },
          {
            name: 'node:module',
            message: 'The domain layer cannot create dynamic CommonJS loaders.',
          },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: "ImportExpression[source.type!='Literal']",
        message: 'Domain dynamic imports must use a literal module specifier.',
      },
    ],
  },
});
