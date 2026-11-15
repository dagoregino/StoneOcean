// Installs the offline voice model used by dictation into public/models/vosk/.
//
//   node tools/vosk/fetch-model.mjs public/models/vosk                    download the official zip
//   node tools/vosk/fetch-model.mjs public/models/vosk path/to/model.zip  use a zip you already have
//   node tools/vosk/fetch-model.mjs public/models/vosk path/to/model.tar.gz
//
// The browser recognizer (vosk-browser) reads a .tar.gz whose single top folder holds the
// model; Alpha Cephei publishes .zip files, so the zip is unpacked and packed again as tar.gz.
// The output name comes from VOSK_MODEL_PATH in src/config.ts, so the app always finds it.
// The official zip of the default model is checked against its known SHA-256; set
// VOSK_MODEL_SHA256 to check another archive.
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

// SHA-256 of the official zips, checked against downloads from alphacephei.com.
const KNOWN_ZIP_SHA256 = {
  'vosk-model-small-en-us-0.15': '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498',
};

async function verify(file, check = true) {
  const digest = await sha256(file);
  const known = file.endsWith('.zip') ? KNOWN_ZIP_SHA256[modelName] : undefined;
  const expected = check ? (process.env.VOSK_MODEL_SHA256 ?? known)?.trim().toLowerCase() : undefined;
  if (expected && expected !== digest) throw new Error(`SHA-256 mismatch for ${file}: expected ${expected}, got ${digest}`);
  console.log(`  sha256 ${digest}  ${basename(file)}${expected ? '  (verified)' : ''}`);
}

const work = mkdtempSync(join(tmpdir(), 'vosk-model-'));
try {
  mkdirSync(outDir, { recursive: true });
  let source = given ? resolve(given) : join(work, `${modelName}.zip`);

  if (!given) {
    console.log(`Downloading ${officialZip}`);
    const byHand = `Download ${officialZip} by hand, then run: npm run model:vosk -- path/to/${modelName}.zip`;
    try {
      const response = await fetch(officialZip);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      writeFileSync(source, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      // Node's fetch ignores HTTPS_PROXY; curl honours it, so behind a proxy it often still works.
      console.log(`  Node could not download it (${error.message}); trying curl.`);
      const curl = spawnSync('curl', ['-sS', '-L', '--fail', '-o', source, officialZip], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
      if (curl.status !== 0) throw new Error(`Could not reach alphacephei.com (${curl.error?.message ?? curl.stderr.trim()}). ${byHand}`);
    }
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
  await verify(output, false);
  console.log('Dictation now works offline: the app serves this file itself and stores it unpacked in the browser after first use.');
} catch (error) {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
