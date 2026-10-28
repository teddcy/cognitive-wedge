// One clock for the whole app so tests and dev mode can move time forward.
let offset = 0;
export const now = () => Date.now() + offset;
export const advance = (ms) => { offset += ms; };
export const reset = () => { offset = 0; };
export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
