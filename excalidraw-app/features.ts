// Sigil: optional services. Each one is on only when its environment
// variables are set (see .env.production), so the default build is the
// single-user editor with no outside servers.

const env = import.meta.env;

export const isCollabConfigured = !!(
  env.VITE_APP_WS_SERVER_URL && env.VITE_APP_FIREBASE_CONFIG
);

export const isShareLinkConfigured = !!(
  env.VITE_APP_BACKEND_V2_GET_URL &&
  env.VITE_APP_BACKEND_V2_POST_URL &&
  env.VITE_APP_FIREBASE_CONFIG
);

export const isAIConfigured = !!env.VITE_APP_AI_BACKEND;
