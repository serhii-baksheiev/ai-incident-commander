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
      name: 'graph-and-domain-do-not-import-model-providers',
      comment:
        'The model provider reaches this workspace through one adapter in packages/roles. ' +
        'Neither the framework-free domain nor the orchestration graph may import that ' +
        'package or a provider SDK directly, which is what keeps both layers ' +
        'provider-independent by mechanism rather than by convention.',
      severity: 'error',
      from: { path: '^packages/(?:domain|graph)/' },
      to: {
        path:
          '^packages/roles(?:/|$)|' +
          '(?:^|/)node_modules/(?:@anthropic-ai(?:/|$)|openai(?:/|$)|@google/generative-ai(?:/|$)|@aws-sdk/client-bedrock)|' +
          '^(?:@anthropic-ai/|openai(?:/|$)|@google/generative-ai(?:/|$)|@aws-sdk/client-bedrock)',
      },
    },
    {
      name: 'domain-does-not-import-orchestration-frameworks',
      comment: 'LangChain and LangGraph stay outside the domain layer.',
      severity: 'error',
      from: { path: '^packages/domain/' },
      to: {
        path: '(?:^|/)node_modules/(?:langchain(?:/|$)|@langchain/)|^(?:langchain(?:/|$)|@langchain/)',
      },
    },
    {
      name: 'graph-does-not-import-persistence',
      comment:
        'AIC-56: the graph layer never reaches the run-scoped PostgreSQL substrate directly — ' +
        'only through whatever bounded port packages/persistence chooses to expose to it, if any.',
      severity: 'error',
      from: { path: '^packages/graph/' },
      to: { path: '^packages/persistence(?:/|$)' },
    },
    {
      name: 'graph-does-not-import-pg',
      comment: 'AIC-56: the graph layer never reaches the PostgreSQL driver directly.',
      severity: 'error',
      from: { path: '^packages/graph/' },
      to: { path: '(?:^|/)node_modules/pg(?:/|$)|^pg(?:/|$)' },
    },
    {
      name: 'only-persistence-imports-pg',
      comment: 'AIC-56: only packages/persistence may import the PostgreSQL driver.',
      severity: 'error',
      from: { path: '^packages/(?!persistence(?:/|$))' },
      to: { path: '(?:^|/)node_modules/pg(?:/|$)|^pg(?:/|$)' },
    },
    {
      name: 'oracle-arm-is-evaluator-side-only',
      comment:
        'AIC-113: the oracle positive control reads ground truth, which no investigating ' +
        'arm may do. Nothing under packages/ may import it — neither by the @aic/evals/oracle ' +
        'subpath nor by a relative path — so it stays reachable from evaluator scripts and ' +
        'tests only.',
      severity: 'error',
      from: {
        path: '^packages/',
        pathNot: '^packages/evals/(?:src|dist)/oracle-arm\\.',
      },
      to: {
        path:
          '(?:^|/)packages/evals/(?:src|dist)/oracle-arm(?:\\.|$)|' +
          '(?:^|/)node_modules/@aic/evals/(?:dist/)?oracle|' +
          '^@aic/evals/oracle$',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
