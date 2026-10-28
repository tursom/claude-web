function absolutePath(value: string) {
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Resolve workspace links without interpreting them relative to the SPA's /s/ URL. */
export function resolveWorkspaceFile(href: string | undefined, cwd: string, documentPath?: string) {
  if (!href || !cwd.startsWith('/')) return undefined;
  let value = href.trim();
  if (!value || /^[#?]/.test(value) || value.startsWith('//') || /[\u0000-\u001f\\]/.test(value))
    return undefined;
  if (/^\/(?:s|api|assets)(?:\/|$)|^\/ws(?:[/?#]|$)/.test(value)) return undefined;
  if (/^[^/:]+\.[a-z\d]+:\d+(?::\d+)?$/i.test(value)) value = value.replace(/:\d+(?::\d+)?$/, '');
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    if (!/^file:/i.test(value)) return undefined;
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return undefined;
      value = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    value = value.split(/[?#]/, 1)[0];
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (!value || /[\u0000-\u001f\\]/.test(value)) return undefined;
  value = value.replace(/:\d+(?::\d+)?$/, '');
  const document = documentPath
    ? absolutePath(documentPath.startsWith('/') ? documentPath : `${cwd}/${documentPath}`)
    : undefined;
  const base = document ? document.slice(0, document.lastIndexOf('/')) : cwd;
  // Authorization (including symlinks and project containment) stays on /api/fs/file.
  return absolutePath(value.startsWith('/') ? value : `${base}/${value}`);
}

export function workspaceFileHref(path: string, sessionPath: string) {
  if (!/^\/s\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\/?$/i.test(sessionPath))
    return undefined;
  return `${sessionPath.replace(/\/$/, '')}?${new URLSearchParams({ tab: 'files', path })}`;
}
