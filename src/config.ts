/** Working title: change it here and it changes everywhere. */
export const APP_TITLE = 'HELIOS';
export const APP_SUBTITLE = 'Astronaut self-assessment console';

/**
 * The demo opens on mission day 45 at 08:00 with 15 days already recorded: 14 complete days
 * for the individual baselines, plus the day that is starting.
 */
export const MISSION_START_MINUTES = 44 * 1440 + 8 * 60;
export const HISTORY_DAYS = 15;

/**
 * Offline voice dictation: the Vosk model archive, relative to the app's base URL.
 * It is a local file (see public/models/vosk/README.md); audio and text never leave the device.
 */
export const VOSK_MODEL_PATH = 'models/vosk/vosk-model-small-en-us-0.15.tar.gz';
