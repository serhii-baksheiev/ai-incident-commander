export default {
  forbidden: [
    {
      name: 'domain-does-not-import-product-implementation',
      comment: 'The framework-free domain package cannot depend on graph or tools.',
      severity: 'error',
      from: { path: '^packages/domain/' },
      to: { path: '^packages/(?:graph|tools)(?:/|$)' },
    },
    {
      name: 'domain-does-not-import-orchestration-frameworks',
      comment: 'LangChain and LangGraph stay outside the domain layer.',
      severity: 'error',
      from: { path: '^packages/domain/' },
      to: { path: '^(?:langchain(?:/|$)|@langchain/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
