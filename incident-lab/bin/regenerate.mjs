import { regenerateV01Candidates } from '../src/scenario-candidates.mjs';

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!['--base-url', '--candidate-directory'].includes(name) || !value) {
      throw new Error(
        'usage: --base-url <loopback-url> --candidate-directory <directory>',
      );
    }
    options[name.slice(2)] = value;
  }
  if (!options['base-url'] || !options['candidate-directory']) {
    throw new Error(
      'usage: --base-url <loopback-url> --candidate-directory <directory>',
    );
  }
  const baseUrl = new URL(options['base-url']);
  if (
    baseUrl.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)
  ) {
    throw new Error('live lab base URL must use HTTP on loopback');
  }
  return {
    baseUrl,
    candidateDirectory: options['candidate-directory'],
  };
}

try {
  const records = await regenerateV01Candidates(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    `${JSON.stringify({
      status: 'recorded',
      candidates: records.map(({ candidatePath }) => candidatePath),
    }, null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
