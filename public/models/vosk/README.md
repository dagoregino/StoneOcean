# Offline voice model (Vosk)

The notes field of "Report discomfort" can be dictated. Speech is recognized **on the device**
by [Vosk](https://alphacephei.com/vosk/) compiled to WebAssembly: audio and transcripts never
leave the browser, and nothing is sent to a speech service.

The app expects one file here, named by `VOSK_MODEL_PATH` in `src/config.ts`:

```
public/models/vosk/vosk-model-small-en-us-0.15.tar.gz
```

**The file is not in the repository yet.** Until it is, the microphone button explains that the
model is not installed, and typing works as before.

## Installing it

```bash
npm run model:vosk
```

This downloads the official `vosk-model-small-en-us-0.15.zip` (about 40 MB) from Alpha Cephei
and packs it again as the `.tar.gz` that the browser recognizer reads (one top folder holding
`am/`, `conf/`, `graph/`…). On a machine with no access to alphacephei.com, download the zip
elsewhere and pass it in:

```bash
npm run model:vosk -- path/to/vosk-model-small-en-us-0.15.zip
```

Set `VOSK_MODEL_SHA256` to have the script check the archive against a hash you trust; it
always prints the SHA-256 of what it read and wrote.

To ship the model with a static deployment (GitHub Pages, Vercel…), commit this file or add the
step above to the deployment build: Vite copies `public/` into `dist/` as it is.

## How it is loaded and cached

- Nothing is loaded until the microphone button is first pressed. The recognizer code, its
  WebAssembly binary and the model are then served by the app itself (same origin only; any
  other origin is refused in `src/speech/vosk/modelSource.ts`).
- Recognition runs in a Web Worker. The model is unpacked once into the browser's IndexedDB
  (database `/vosk`) and read from there on every later visit, so dictation works with no
  network at all. The app asks the browser to keep that storage persistent.
- If loading fails (damaged archive, storage full), the stored copy is deleted so that the next
  attempt reads the file again.

## Another language or model

Any Vosk model works. Pack it as above, then change `VOSK_MODEL_PATH` in `src/config.ts`.
Small models (40–50 MB) suit the browser; the large server models do not.
The keyword suggestions (`src/domain/noteSuggestions.ts`) already cover English and Spanish.

## Licence

`vosk-model-small-en-us-0.15` is published by Alpha Cephei under the Apache License 2.0.
The recognizer, `@lichess-org/vosk-browser` (a fork of `vosk-browser` by Ciaran O'Reilly), is
also Apache-2.0.
