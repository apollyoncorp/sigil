// The fork's element code reads `window` at import time; the bundle sets the
// same alias in its banner.
(globalThis as any).window ??= globalThis;
