import { describe, it, expect, vi } from 'vitest';
import { CellGrid } from '@react-term/core';
import { findLinks, WebLinksAddon } from '../addons/web-links.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gridWithText(texts: string[], cols = 80, rows?: number): CellGrid {
  const r = rows ?? texts.length;
  const grid = new CellGrid(cols, r);
  for (let row = 0; row < texts.length; row++) {
    const text = texts[row];
    for (let col = 0; col < text.length && col < cols; col++) {
      const cp = text.charCodeAt(col);
      grid.setCell(row, col, cp, 7, 0, 0);
    }
  }
  return grid;
}

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

describe('findLinks', () => {
  it('detects http URL', () => {
    const grid = gridWithText(['Visit http://example.com today']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('http://example.com');
    expect(links[0].row).toBe(0);
    expect(links[0].startCol).toBe(6);
  });

  it('detects https URL', () => {
    const grid = gridWithText(['Go to https://example.com/path']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/path');
  });

  it('detects URL with query params', () => {
    const grid = gridWithText(['https://example.com/search?q=test&page=1']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/search?q=test&page=1');
  });

  it('detects URL with fragment', () => {
    const grid = gridWithText(['https://example.com/page#section']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/page#section');
  });

  it('detects URL with port', () => {
    const grid = gridWithText(['http://localhost:3000/api']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('http://localhost:3000/api');
  });

  it('detects multiple URLs on different rows', () => {
    const grid = gridWithText([
      'First: https://example.com',
      'Second: https://other.com',
    ]);
    const links = findLinks(grid);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe('https://example.com');
    expect(links[0].row).toBe(0);
    expect(links[1].url).toBe('https://other.com');
    expect(links[1].row).toBe(1);
  });

  it('detects multiple URLs on same row', () => {
    const grid = gridWithText(['https://a.com and https://b.com']);
    const links = findLinks(grid);
    expect(links).toHaveLength(2);
    expect(links[0].url).toBe('https://a.com');
    expect(links[1].url).toBe('https://b.com');
  });

  it('does not detect non-URL text', () => {
    const grid = gridWithText(['This is plain text']);
    const links = findLinks(grid);
    expect(links).toHaveLength(0);
  });

  it('does not detect partial URL without protocol', () => {
    const grid = gridWithText(['example.com is a website']);
    const links = findLinks(grid);
    expect(links).toHaveLength(0);
  });

  it('trims trailing punctuation from URLs', () => {
    const grid = gridWithText(['See https://example.com.']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com');
  });

  it('trims trailing comma from URLs', () => {
    const grid = gridWithText(['Visit https://example.com, then']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com');
  });

  it('trims trailing parenthesis from URLs', () => {
    const grid = gridWithText(['(see https://example.com)']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com');
  });

  it('handles URL with path and trailing slash', () => {
    const grid = gridWithText(['https://example.com/path/to/page/']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com/path/to/page/');
  });

  it('returns correct column positions', () => {
    const grid = gridWithText(['     https://x.com']);
    const links = findLinks(grid);
    expect(links).toHaveLength(1);
    expect(links[0].startCol).toBe(5);
    expect(links[0].endCol).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Default handler URL scheme guard
// ---------------------------------------------------------------------------

describe('WebLinksAddon default handler', () => {
  it('opens http URLs', () => {
    const openSpy = vi.fn();
    vi.stubGlobal('window', { open: openSpy });

    const addon = new WebLinksAddon();
    // Access the default handler via a click simulation — invoke handler directly
    (addon as unknown as { handler: (url: string) => void }).handler('http://example.com');

    expect(openSpy).toHaveBeenCalledWith('http://example.com', '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();
  });

  it('opens https URLs', () => {
    const openSpy = vi.fn();
    vi.stubGlobal('window', { open: openSpy });

    const addon = new WebLinksAddon();
    (addon as unknown as { handler: (url: string) => void }).handler('https://example.com');

    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    vi.unstubAllGlobals();
  });

  it('rejects javascript: URLs', () => {
    const openSpy = vi.fn();
    vi.stubGlobal('window', { open: openSpy });

    const addon = new WebLinksAddon();
    (addon as unknown as { handler: (url: string) => void }).handler('javascript:alert(1)');

    expect(openSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rejects data: URLs', () => {
    const openSpy = vi.fn();
    vi.stubGlobal('window', { open: openSpy });

    const addon = new WebLinksAddon();
    (addon as unknown as { handler: (url: string) => void }).handler('data:text/html,<script>alert(1)</script>');

    expect(openSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
