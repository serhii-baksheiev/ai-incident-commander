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
        'arm may do. No module under packages/ or apps/ other than the oracle itself may ' +
        'import it, by the @aic/evals/oracle subpath or by a relative path. Evaluator ' +
        'scripts and tests sit outside the cruised tree and are not governed by this rule.',
      severity: 'error',
      from: {
        path: '^(?:packages|apps)/',
        pathNot: '^packages/evals/(?:src|dist)/oracle-arm\\.',
      },
      to: {
        path:
          '(?:^|/)packages/evals/(?:src|dist)/oracle-arm(?:\\.|$)|' +
          '(?:^|/)node_modules/@aic/evals/(?:dist/)?oracle|' +
          '^@aic/evals/oracle$',
      },
    },
    {
      name: 'benchmark-ground-truth-is-evaluator-side-only',
      comment:
        'AIC-113: @aic/evals carries the benchmark scenarios and their ground truth. No ' +
        'package other than evals itself, and no app, may import it, so an investigating ' +
        'layer cannot read the answers it is scored against.',
      severity: 'error',
      from: { path: '^(?:packages/(?!evals/)|apps/)' },
      to: {
        path:
          '(?:^|/)packages/evals/|' +
          '(?:^|/)node_modules/@aic/evals(?:/|$)|' +
          '^@aic/evals(?:/|$)',
      name: 'naive-role-does-not-import-the-graph',
      comment:
        'AIC-115: the naive single-prompt role is the no-graph baseline the graph arm is ' +
        'measured against. It may not import the orchestration graph, directly or through ' +
        'any module it imports.',
      severity: 'error',
      from: { path: '^packages/roles/(?:src|dist)/naive-role\\.' },
      to: {
        path: '(?:^|/)packages/graph(?:/|$)|(?:^|/)node_modules/@aic/graph(?:/|$)|^@aic/graph(?:/|$)',
        reachable: true,
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
