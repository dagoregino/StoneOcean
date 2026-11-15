// Installs the offline voice model used by dictation into public/models/vosk/.
//
//   node tools/vosk/fetch-model.mjs public/models/vosk                    download the official zip
//   node tools/vosk/fetch-model.mjs public/models/vosk path/to/model.zip  use a zip you already have
//   node tools/vosk/fetch-model.mjs public/models/vosk path/to/model.tar.gz
//
// The browser recognizer (vosk-browser) reads a .tar.gz whose single top folder holds the
// model; Alpha Cephei publishes .zip files, so the zip is unpacked and packed again as tar.gz.
// The output name comes from VOSK_MODEL_PATH in src/config.ts, so the app always finds it.
// Set VOSK_MODEL_SHA256 to check the downloaded or given archive against a known hash.
// Needs `unzip` and `tar` on the PATH. This is a build-time step: the app never downloads
// anything from Alpha Cephei, it only reads the file this script writes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const [outDir, given] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node tools/vosk/fetch-model.mjs <output dir> [model.zip | model.tar.gz]');
  process.exit(2);
}

const config = readFileSync('src/config.ts', 'utf8');
const configured = config.match(/VOSK_MODEL_PATH\s*=\s*'([^']+)'/)?.[1];
if (!configured) throw new Error('VOSK_MODEL_PATH not found in src/config.ts');
const archiveName = basename(configured);
const modelName = archiveName.replace(/\.tar\.gz$/, '');
const output = resolve(outDir, archiveName);
const officialZip = `https://alphacephei.com/vosk/models/${modelName}.zip`;

const sha256 = (file) =>
  new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => done(hash.digest('hex'))).on('error', fail);
  });

const sh = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') throw new Error(`"${cmd}" is not installed; it is needed to repack the model.`);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr.trim()}`);
};

async function verify(file) {
  const digest = await sha256(file);
  const expected = process.env.VOSK_MODEL_SHA256?.trim().toLowerCase();
  if (expected && expected !== digest) throw new Error(`SHA-256 mismatch for ${file}: expected ${expected}, got ${digest}`);
  console.log(`  sha256 ${digest}  ${basename(file)}${expected ? '  (matches VOSK_MODEL_SHA256)' : ''}`);
}

const work = mkdtempSync(join(tmpdir(), 'vosk-model-'));
try {
  mkdirSync(outDir, { recursive: true });
  let source = given ? resolve(given) : join(work, `${modelName}.zip`);

  if (!given) {
    console.log(`Downloading ${officialZip}`);
    const byHand = `Download ${officialZip} by hand, then run: npm run model:vosk -- path/to/${modelName}.zip`;
    const response = await fetch(officialZip).catch((error) => {
      throw new Error(`Could not reach alphacephei.com (${error.message}). ${byHand}`);
    });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}. ${byHand}`);
    writeFileSync(source, Buffer.from(await response.arrayBuffer()));
  } else if (!existsSync(source)) {
    throw new Error(`Not found: ${source}`);
  }
  await verify(source);

  if (source.endsWith('.tar.gz') || source.endsWith('.tgz')) {
    copyFileSync(source, output);
  } else {
    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    sh('unzip', ['-q', source, '-d', unpacked]);
    // The model files must sit inside exactly one top folder: the recognizer strips it.
    const top = readdirSync(unpacked).filter((name) => !name.startsWith('.') && !name.startsWith('__MACOSX'));
    const folder = top.length === 1 && statSync(join(unpacked, top[0])).isDirectory() ? top[0] : null;
    const root = folder ? unpacked : join(work, 'wrapped');
    if (!folder) {
      mkdirSync(join(root, modelName), { recursive: true });
      sh('cp', ['-R', `${unpacked}/.`, join(root, modelName)]);
    }
    const name = folder ?? modelName;
    if (!existsSync(join(root, name, 'am')) && !existsSync(join(root, name, 'conf'))) {
      throw new Error(`${basename(source)} does not look like a Vosk model (no am/ or conf/ folder).`);
    }
    sh('tar', ['-czf', output, '-C', root, name]);
  }

  console.log(`Wrote ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
  await verify(output);
  console.log('Dictation now works offline: the app serves this file itself and stores it unpacked in the browser after first use.');
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
