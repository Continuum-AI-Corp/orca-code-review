// Shared control-plane base-URL derivation for settings.mjs / report.mjs.
//
// The `orcarouter-url` input points at the chat-completions endpoint
// (e.g. https://api.orcarouter.ai/v1/chat/completions). The control-plane
// APIs (/api/code_review/...) live on the same deployment, one level above
// the /v1 relay prefix. Taking `new URL(url).origin` would discard any
// sub-path a self-hosted gateway is mounted under (https://host/orca/v1/...
// must map to https://host/orca/api/..., not https://host/api/...), so we
// strip only the trailing /v1/<anything> segment and keep the rest.
//
// Throws on an unparseable URL — callers keep their existing try/catch
// fail-open behavior.
export function controlPlaneBase(urlString) {
  const u = new URL(urlString); // throws on garbage
  const path = u.pathname.replace(/\/v1(\/.*)?$/, "");
  return `${u.origin}${path.replace(/\/+$/, "")}`;
}
