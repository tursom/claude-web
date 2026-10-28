import { describe, expect, it } from 'vitest';
import { resolveWorkspaceFile, workspaceFileHref } from '../web/src/components/file-links';

describe('workspace Markdown file links', () => {
  it('resolves response links from cwd and document links from the document directory', () => {
    expect(
      resolveWorkspaceFile(
        'finance-admin-service/docs/frontend-redesign-prototype.html',
        '/root/dev/work/yym',
      ),
    ).toBe('/root/dev/work/yym/finance-admin-service/docs/frontend-redesign-prototype.html');
    expect(resolveWorkspaceFile('../preview.html', '/project', 'docs/guide/README.md')).toBe(
      '/project/docs/preview.html',
    );
    expect(resolveWorkspaceFile('./preview.html', '/project', '/project/docs/README.md')).toBe(
      '/project/docs/preview.html',
    );
  });
  it('handles absolute paths, file URLs, encoded characters, and line suffixes', () => {
    expect(resolveWorkspaceFile('/project/a%20b%23c.html#section', '/project')).toBe('/project/a b#c.html');
    expect(resolveWorkspaceFile('file:///project/%E9%A1%B5%E9%9D%A2.html', '/project')).toBe(
      '/project/页面.html',
    );
    expect(resolveWorkspaceFile('file://localhost/project/a.html', '/project')).toBe('/project/a.html');
    expect(resolveWorkspaceFile('src/app.ts:12:3', '/project')).toBe('/project/src/app.ts');
    expect(resolveWorkspaceFile('app.ts:12:3', '/project')).toBe('/project/app.ts');
  });
  it('leaves external URLs and fragment links alone and rejects invalid file URLs', () => {
    for (const href of [
      'https://example.com/a.html',
      'http://example.com',
      '//example.com/a.html',
      'mailto:a@example.com',
      'tel:123',
      '#footnote',
      '?tab=files',
      '/s/11111111-1111-4111-8111-111111111111?tab=files',
      '/api/uploads/image',
      'javascript:alert(1)',
      'data:text/html,test',
      'file://remote/project/a.html',
      '%00a.html',
      'bad%ZZ.html',
    ]) {
      expect(resolveWorkspaceFile(href, '/project'), href).toBeUndefined();
    }
  });
  it('builds shareable SPA URLs with literal paths preserved in query parameters', () => {
    const route = '/s/11111111-1111-4111-8111-111111111111';
    const href = workspaceFileHref('/project/a b#c.html', route)!;
    const url = new URL(href, 'https://example.com');
    expect(url.pathname).toBe(route);
    expect(url.searchParams.get('path')).toBe('/project/a b#c.html');
    expect(url.searchParams.get('tab')).toBe('files');
    expect(workspaceFileHref('/project/a.html', '/s/finance-admin-service/docs/a.html')).toBeUndefined();
  });
});
