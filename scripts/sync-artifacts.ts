/**
 * Copies the compiled ABI and creation bytecode into a committed TypeScript module, so the
 * application never depends on `contracts/out` existing at runtime.
 *
 * Run after changing the Solidity source: `pnpm contracts:build && pnpm contracts:sync`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = resolve(repoRoot, 'contracts/out/InstitutionalToken.sol/InstitutionalToken.json');
const outputPath = resolve(repoRoot, 'src/adapters/evm/token-artifact.ts');

execFileSync('forge', ['build', '--root', 'contracts'], { cwd: repoRoot, stdio: 'inherit' });

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
  abi: unknown[];
  bytecode: { object: string };
};

const bytecode = artifact.bytecode.object;
if (!bytecode.startsWith('0x') || bytecode.length < 10) {
  throw new Error(`unexpected creation bytecode in ${artifactPath}`);
}

const contents = `// GENERATED FILE - do not edit by hand.
// Source: contracts/src/InstitutionalToken.sol
// Regenerate with: pnpm contracts:sync

export const institutionalTokenAbi = ${JSON.stringify(artifact.abi, null, 2)} as const;

export const institutionalTokenBytecode =
  '${bytecode}' as \`0x\${string}\`;
`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, contents);
console.log(`wrote ${outputPath} (abi entries: ${artifact.abi.length})`);
