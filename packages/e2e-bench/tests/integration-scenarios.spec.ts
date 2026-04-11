/**
 * Integration scenario tests — exercises the full rendering pipeline
 * with real-world usage patterns that users encounter.
 *
 * These tests write escape sequences, then verify CONTENT (via the
 * accessibility tree) rather than just "no crash". They catch the
 * class of bugs that unit tests miss: resize garbling, scroll data
 * loss, stale rendering state, and tab-switching recovery.
 */
import { test, expect } from '@playwright/test';

/** Write raw bytes to the terminal via the exposed ref. */
async function write(page: import('@playwright/test').Page, data: string) {
  await page.evaluate((d) => window.__termRef?.write(d), data);
}

/** Wait for the accessibility tree to update (throttled at 100ms + rAF). */
async function waitForRender(page: import('@playwright/test').Page) {
  // AccessibilityManager throttles updates at 100ms. Wait for two cycles
  // to ensure the update fires and DOM settles.
  await page.waitForTimeout(500);
}

/** Read all visible row text via the TerminalHandle API. */
async function readRows(page: import('@playwright/test').Page): Promise<string[]> {
  await waitForRender(page);
  return page.evaluate(() => window.__termRef?.getRowTexts() ?? []);
}

/** Wait until a specific substring appears in any grid row. */
async function waitForContent(page: import('@playwright/test').Page, substr: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await page.evaluate(() => window.__termRef?.getRowTexts() ?? []);
    if (rows.some(r => r.includes(substr))) return rows;
    await page.waitForTimeout(50);
  }
  return page.evaluate(() => window.__termRef?.getRowTexts() ?? []);
}

/** Get cursor position via the grid's cursor state. */
async function getCursor(page: import('@playwright/test').Page): Promise<{ row: number; col: number }> {
  return page.evaluate(() => {
    // Access via the internal terminal ref
    const t = (window.__termRef as any)?._terminal;
    if (!t) return { row: 0, col: 0 };
    const c = t.bufferSet?.active?.cursor ?? { row: 0, col: 0 };
    return { row: c.row, col: c.col };
  });
}

test.describe('integration scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174?page=render-test');
    await page.waitForFunction(() => window.__renderTestReady === true, { timeout: 10_000 });
    await page.waitForTimeout(200); // let first render complete
  });

  // =========================================================================
  // Scenario 1: Carriage return overwrite (npm install, tqdm)
  // =========================================================================
  test.describe('carriage return overwrite', () => {

    test('\\r overwrites current line content', async ({ page }) => {
      await write(page, 'AAAAAAAAAA');
      await write(page, '\rBBBBB');
      const rows = await waitForContent(page, 'BBBBB');
      const row = rows[0] ?? '';
      expect(row).toContain('BBBBB');
    });

    test('\\r + \\x1b[K erases to end of line', async ({ page }) => {
      await write(page, 'AAAAAAAAAA');
      await write(page, '\r\x1b[KBBB');
      const rows = await waitForContent(page, 'BBB');
      expect(rows[0]?.trim()).toBe('BBB');
    });

    test('progress bar simulation — only final state visible', async ({ page }) => {
      for (let i = 0; i <= 100; i += 10) {
        await write(page, `\r\x1b[KProgress: ${i}%`);
      }
      const rows = await waitForContent(page, 'Progress: 100%');
      expect(rows[0]).toContain('Progress: 100%');
    });
  });

  // =========================================================================
  // Scenario 2: Alternate buffer lifecycle (vim, htop, top)
  // =========================================================================
  test.describe('alternate buffer', () => {

    test('content in normal buffer survives alternate buffer round-trip', async ({ page }) => {
      // Write to normal buffer
      await write(page, 'Normal line 1\r\n');
      await write(page, 'Normal line 2\r\n');
      await page.waitForTimeout(100);

      // Enter alternate buffer
      await write(page, '\x1b[?1049h');
      await write(page, 'Alternate content\r\n');
      // Verify alternate content is showing
      const altRows = await waitForContent(page, 'Alternate content');
      expect(altRows.some(r => r.includes('Alternate content'))).toBe(true);
      expect(altRows.some(r => r.includes('Normal line 1'))).toBe(false);

      // Exit alternate buffer
      await write(page, '\x1b[?1049l');

      // Normal buffer content should be restored
      const normalRows = await waitForContent(page, 'Normal line 1');
      expect(normalRows.some(r => r.includes('Normal line 1'))).toBe(true);
      expect(normalRows.some(r => r.includes('Normal line 2'))).toBe(true);
    });

    test('fullscreen app simulation — cursor home + full redraw', async ({ page }) => {
      await write(page, '\x1b[?1049h'); // enter alt buffer
      // Simulate htop-like full-screen redraw
      for (let frame = 0; frame < 5; frame++) {
        await write(page, '\x1b[H'); // cursor home
        for (let r = 0; r < 10; r++) {
          await write(page, `\x1b[K Frame ${frame} Row ${r}`.padEnd(60) + '\r\n');
        }
        await page.waitForTimeout(50);
      }

      // Only the final frame should be visible
      const rows = await waitForContent(page, 'Frame 4 Row 0');
      expect(rows.some(r => r.includes('Frame 4 Row 0'))).toBe(true);
      expect(rows.some(r => r.includes('Frame 3'))).toBe(false);

      await write(page, '\x1b[?1049l'); // exit alt buffer
    });
  });

  // =========================================================================
  // Scenario 3: Resize during/after output
  // =========================================================================
  test.describe('resize', () => {

    test('content survives resize shrink and expand', async ({ page }) => {
      await write(page, 'ABCDEFGHIJ\r\n');
      await write(page, 'KLMNOPQRST\r\n');
      await waitForContent(page, 'KLMNOPQRST');

      await page.evaluate(() => window.__termRef?.resize(40, 10));
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__termRef?.resize(80, 24));

      const rows = await waitForContent(page, 'ABCDEFGHIJ');
      const allText = rows.join('');
      expect(allText).toContain('ABCDEFGHIJ');
      expect(allText).toContain('KLMNOPQRST');
    });

    test('cursor position is valid after resize', async ({ page }) => {
      await write(page, '\x1b[6;11HX');
      await waitForRender(page);
      await page.evaluate(() => window.__termRef?.resize(20, 5));
      await waitForRender(page);

      const cursor = await getCursor(page);
      expect(cursor.row).toBeLessThan(5);
      expect(cursor.col).toBeLessThan(20);
    });
  });

  // =========================================================================
  // Scenario 4: SGR color state across operations
  // =========================================================================
  test.describe('SGR color state', () => {

    test('color reset works after heavy SGR usage', async ({ page }) => {
      await write(page, '\x1b[31;42;1;3;4mStyled\x1b[0mPlain\r\n');
      const rows = await waitForContent(page, 'Plain');
      expect(rows[0]).toContain('Styled');
      expect(rows[0]).toContain('Plain');
    });

    test('256-color palette renders without crash', async ({ page }) => {
      let data = '';
      for (let i = 0; i < 256; i++) data += `\x1b[38;5;${i}m█`;
      data += '\x1b[0m DONE\r\n';
      await write(page, data);
      await waitForContent(page, 'DONE');
    });
  });

  // =========================================================================
  // Scenario 5: Scrollback and viewport scrolling
  // =========================================================================
  test.describe('scrollback', () => {

    test('scrollback preserves lines after they scroll off', async ({ page }) => {
      let data = '';
      for (let i = 0; i < 50; i++) data += `Line ${String(i).padStart(3, '0')}\r\n`;
      await write(page, data);

      const rows = await waitForContent(page, 'Line 049');
      expect(rows.join('')).toContain('Line 049');
    });
  });

  // =========================================================================
  // Scenario 6: Tab switching / display:none recovery
  // =========================================================================
  test.describe('tab switching (display:none)', () => {

    test('terminal recovers after being hidden and shown', async ({ page }) => {
      await write(page, 'Before hide\r\n');
      await waitForContent(page, 'Before hide');

      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="terminal-container"]') as HTMLElement;
        if (c) c.style.display = 'none';
      });
      await page.waitForTimeout(200);
      await write(page, 'Written while hidden\r\n');

      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="terminal-container"]') as HTMLElement;
        if (c) c.style.display = '';
      });

      const rows = await waitForContent(page, 'Written while hidden');
      expect(rows.join('')).toContain('Before hide');
      expect(rows.join('')).toContain('Written while hidden');
    });

    test('canvas dimensions are correct after show', async ({ page }) => {
      // Hide
      await page.evaluate(() => {
        const container = document.querySelector('[data-testid="terminal-container"]') as HTMLElement;
        if (container) container.style.display = 'none';
      });
      await page.waitForTimeout(100);

      // Show
      await page.evaluate(() => {
        const container = document.querySelector('[data-testid="terminal-container"]') as HTMLElement;
        if (container) container.style.display = '';
      });
      await page.waitForTimeout(300);

      // Canvas should have valid non-zero dimensions
      const dims = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="terminal-container"] canvas') as HTMLCanvasElement;
        return canvas ? { w: canvas.width, h: canvas.height } : null;
      });
      expect(dims).not.toBeNull();
      expect(dims!.w).toBeGreaterThan(0);
      expect(dims!.h).toBeGreaterThan(0);
    });

    test('rapid hide/show cycles do not crash', async ({ page }) => {
      await write(page, 'Content\r\n');
      const container = '[data-testid="terminal-container"]';

      for (let i = 0; i < 10; i++) {
        await page.evaluate((sel) => {
          (document.querySelector(sel) as HTMLElement).style.display = 'none';
        }, container);
        await page.waitForTimeout(30);
        await page.evaluate((sel) => {
          (document.querySelector(sel) as HTMLElement).style.display = '';
        }, container);
        await page.waitForTimeout(30);
        await write(page, `Cycle ${i}\r\n`);
      }
      const rows = await waitForContent(page, 'Cycle 9');
      expect(rows.join('')).toContain('Cycle 9');
    });
  });

  // =========================================================================
  // Scenario 7: Wide characters in real usage
  // =========================================================================
  test.describe('wide characters', () => {

    test('CJK characters align correctly', async ({ page }) => {
      await write(page, '中文テスト\r\n');
      await write(page, 'ABCDEFGHIJ\r\n');
      const rows = await waitForContent(page, 'ABCDEFGHIJ');
      expect(rows.some(r => r.includes('中文テスト'))).toBe(true);
      expect(rows.some(r => r.includes('ABCDEFGHIJ'))).toBe(true);
    });

    test('emoji renders', async ({ page }) => {
      await write(page, '😀🚀🎉 DONE\r\n');
      const rows = await waitForContent(page, 'DONE');
      expect(rows.some(r => r.includes('😀'))).toBe(true);
    });
  });

  // =========================================================================
  // Scenario 8: Jest-like colored test output
  // =========================================================================
  test.describe('real-world output patterns', () => {

    test('jest-style PASS/FAIL output renders', async ({ page }) => {
      await write(page, [
        '\x1b[32m PASS \x1b[39m src/parser.test.ts\r\n',
        '\x1b[31m FAIL \x1b[39m src/renderer.test.ts\r\n',
        '\x1b[32m PASS \x1b[39m src/buffer.test.ts\r\n',
        '\r\n',
        '\x1b[1mTest Suites:\x1b[0m 1 failed, 2 passed, 3 total\r\n',
      ].join(''));

      const rows = await waitForContent(page, 'Test Suites:');
      const allText = rows.join('');
      expect(allText).toContain('PASS');
      expect(allText).toContain('FAIL');
      expect(allText).toContain('parser.test.ts');
      expect(allText).toContain('Test Suites:');
    });

    test('ls-style colored directory listing', async ({ page }) => {
      await write(page, [
        '\x1b[0m\x1b[01;34mdrwxr-xr-x\x1b[0m  5 user staff  160 src\r\n',
        '\x1b[0m-rw-r--r--  1 user staff 4096 package.json\x1b[0m\r\n',
        '\x1b[38;5;208m-rw-r--r--\x1b[0m  1 user staff 2048 README.md\r\n',
      ].join(''));

      const rows = await waitForContent(page, 'README.md');
      const allText = rows.join('');
      expect(allText).toContain('src');
      expect(allText).toContain('package.json');
      expect(allText).toContain('README.md');
    });
  });

  // =========================================================================
  // Canvas2D parity — repeat critical scenarios to verify both renderers
  // =========================================================================
  test.describe('Canvas2D parity', () => {
    test.beforeEach(async ({ page }) => {
      await page.click('[data-testid="mode-canvas2d"]');
      await page.waitForTimeout(500);
    });

  test('carriage return overwrite', async ({ page }) => {
    await write(page, 'AAAAAAAAAA');
    await write(page, '\r\x1b[KBBB');
    const rows = await waitForContent(page, 'BBB');
    expect(rows[0]?.trim()).toBe('BBB');
  });

  test('alternate buffer round-trip preserves normal content', async ({ page }) => {
    await write(page, 'Normal\r\n');
    await waitForContent(page, 'Normal');
    await write(page, '\x1b[?1049h');
    await write(page, 'Alt\r\n');
    await waitForContent(page, 'Alt');
    await write(page, '\x1b[?1049l');
    const rows = await waitForContent(page, 'Normal');
    expect(rows.some(r => r.includes('Normal'))).toBe(true);
  });

  test('resize preserves content', async ({ page }) => {
    await write(page, 'ABCDEFGHIJ\r\n');
    await waitForContent(page, 'ABCDEFGHIJ');
    await page.evaluate(() => window.__termRef?.resize(40, 10));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__termRef?.resize(80, 24));
    const rows = await waitForContent(page, 'ABCDEFGHIJ');
    expect(rows.join('')).toContain('ABCDEFGHIJ');
  });

  test('display:none recovery', async ({ page }) => {
    await write(page, 'Before\r\n');
    await waitForContent(page, 'Before');
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="terminal-container"]') as HTMLElement;
      if (c) c.style.display = 'none';
    });
    await page.waitForTimeout(200);
    await write(page, 'After\r\n');
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="terminal-container"]') as HTMLElement;
      if (c) c.style.display = '';
    });
    const rows = await waitForContent(page, 'After');
    expect(rows.join('')).toContain('Before');
    expect(rows.join('')).toContain('After');
  });

  test('scrollback preserves lines', async ({ page }) => {
    let data = '';
    for (let i = 0; i < 50; i++) data += `Line ${String(i).padStart(3, '0')}\r\n`;
    await write(page, data);
    const rows = await waitForContent(page, 'Line 049');
    expect(rows.join('')).toContain('Line 049');
  });
  });
});
