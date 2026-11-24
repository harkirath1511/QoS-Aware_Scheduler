import { analyze } from '../src/vibration';
import { Fault, jobInput } from '../src/domain';

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const spec = jobInput.parse(JSON.parse(process.argv[2]));
  process.stdout.write(JSON.stringify(analyze(Buffer.concat(chunks), spec)));
}

main().catch(error => {
  process.stderr.write(error instanceof Fault ? error.message : 'Analysis failed.');
  process.exitCode = error instanceof Fault ? 2 : 1;
});
