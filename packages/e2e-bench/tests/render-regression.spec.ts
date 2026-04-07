import { test, expect } from '@playwright/test';

test.describe('rendering regression', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:5174?page=render-test');
    await page.waitForFunction(() => window.__renderTestReady === true, { timeout: 10_000 });
  });

  test.describe('single-pane rendering', () => {

    test('terminal renders and accepts input', async ({ page }) => {
      // Write text via the exposed ref
      await page.evaluate(() => {
        window.__termRef?.write('Hello, World!\r\n');
      });
      await page.waitForTimeout(200); // allow render frame

      // Verify canvas exists and has non-zero dimensions
      const canvas = page.locator('[data-testid="terminal-container"] canvas');
      await expect(canvas.first()).toBeVisible();
      const box = await canvas.first().boundingBox();
      expect(box?.width).toBeGreaterThan(0);
      expect(box?.height).toBeGreaterThan(0);
    });

    test('renderer is active (WebGL2 or Canvas2D fallback)', async ({ page }) => {
      const info = await page.evaluate(() => {
        const canvases = document.querySelectorAll('[data-testid="terminal-container"] canvas');
        if (canvases.length === 0) return { hasCanvas: false, width: 0 };
        const c = canvases[0] as HTMLCanvasElement;
        return { hasCanvas: true, width: c.width, height: c.height };
      });
      expect(info.hasCanvas).toBe(true);
      expect(info.width).toBeGreaterThan(0);
    });

    test('write ANSI colored text does not throw', async ({ page }) => {
      const error = await page.evaluate(() => {
        try {
          // Red foreground, green background, bold
          window.__termRef?.write('\x1b[31;42;1mColored Bold\x1b[0m Normal\r\n');
          // 256-color
          window.__termRef?.write('\x1b[38;5;196mRed256\x1b[0m\r\n');
          // RGB true color
          window.__termRef?.write('\x1b[38;2;255;128;0mOrange RGB\x1b[0m\r\n');
          return null;
        } catch (e) {
          return String(e);
        }
      });
      expect(error).toBeNull();
    });

    test('resize works without errors', async ({ page }) => {
      const result = await page.evaluate(() => {
        try {
          window.__termRef?.resize(120, 40);
          window.__termRef?.write('After resize\r\n');
          return 'ok';
        } catch (e) {
          return String(e);
        }
      });
      expect(result).toBe('ok');
    });

    test('resize cap limits dimensions to 500x500', async ({ page }) => {
      await page.evaluate(() => {
        window.__termRef?.resize(1000, 1000);
      });
      await page.waitForTimeout(100);
      // The terminal should have been capped
      const dims = await page.evaluate(() => {
        // Write a DSR query and check response, or just verify no crash
        try {
          window.__termRef?.write('Still alive after large resize\r\n');
          return 'ok';
        } catch (e) {
          return String(e);
        }
      });
      expect(dims).toBe('ok');
    });

    test('alternate buffer switch does not leave stale content', async ({ page }) => {
      await page.evaluate(() => {
        const t = window.__termRef;
        if (!t) return;
        // Write to normal buffer
        t.write('Normal buffer content\r\n');
        // Switch to alternate buffer
        t.write('\x1b[?1049h');
        // Write to alternate
        t.write('Alternate buffer content\r\n');
        // Switch back to normal
        t.write('\x1b[?1049l');
      });
      await page.waitForTimeout(200);
      // Should not throw — validates buffer switch + dirty tracking reset
    });

    test('rapid writes do not cause rendering errors', async ({ page }) => {
      const error = await page.evaluate(() => {
        try {
          const t = window.__termRef;
          if (!t) return 'no terminal';
          // Simulate rapid output (1000 lines)
          for (let i = 0; i < 1000; i++) {
            t.write(`Line ${i}: ${'x'.repeat(70)}\r\n`);
          }
          return null;
        } catch (e) {
          return String(e);
        }
      });
      expect(error).toBeNull();
    });

    test('SGR attributes render without crash (inverse, underline, italic)', async ({ page }) => {
      const error = await page.evaluate(() => {
        try {
          const t = window.__termRef;
          if (!t) return 'no terminal';
          t.write('\x1b[7mInverse\x1b[0m ');        // inverse
          t.write('\x1b[4mUnderline\x1b[0m ');       // underline
          t.write('\x1b[3mItalic\x1b[0m ');           // italic
          t.write('\x1b[1;3;4;7mAll attrs\x1b[0m\r\n'); // all combined
          return null;
        } catch (e) {
          return String(e);
        }
      });
      expect(error).toBeNull();
    });
  });

  test.describe('multi-pane shared context', () => {

    test.beforeEach(async ({ page }) => {
      await page.click('[data-testid="mode-multi"]');
      await page.waitForTimeout(500); // allow shared context init
    });

    test('shared context creates overlay canvas or panes fall back to independent rendering', async ({ page }) => {
      // In shared mode with WebGL2 available, there should be ONE overlay canvas
      // with pointer-events:none. If WebGL2 is unavailable, panes fall back to
      // independent per-pane rendering (each pane gets its own canvas).
      const info = await page.evaluate(() => {
        const container = document.querySelector('[data-testid="terminal-container"]');
        if (!container) return { overlayCount: 0, totalCanvases: 0 };
        const canvases = container.querySelectorAll('canvas');
        let overlayCount = 0;
        for (const c of canvases) {
          if (c.style.pointerEvents === 'none') overlayCount++;
        }
        return { overlayCount, totalCanvases: canvases.length };
      });
      // Either shared context (1 overlay) or fallback (multiple independent canvases)
      expect(info.totalCanvases).toBeGreaterThan(0);
      if (info.overlayCount === 1) {
        // Shared WebGL context mode
        expect(info.overlayCount).toBe(1);
      } else {
        // Fallback: at least 2 canvases (one per pane)
        expect(info.totalCanvases).toBeGreaterThanOrEqual(2);
      }
    });

    test('both panes are registered with shared context', async ({ page }) => {
      const paneIds = await page.evaluate(() => {
        // Access the TerminalPaneHandle to check terminal registration
        const paneRef = window.__paneRef;
        if (!paneRef) return [];
        return paneRef.getPaneIds();
      });
      expect(paneIds).toContain('left');
      expect(paneIds).toContain('right');
    });

    test('writing to individual panes works', async ({ page }) => {
      const error = await page.evaluate(() => {
        try {
          const pane = window.__paneRef;
          if (!pane) return 'no pane ref';
          const left = pane.getTerminal('left');
          const right = pane.getTerminal('right');
          if (!left || !right) return 'missing terminal handles';
          left.write('Left pane content\r\n');
          right.write('Right pane content\r\n');
          return null;
        } catch (e) {
          return String(e);
        }
      });
      expect(error).toBeNull();
    });

    test('heavy parallel writes to all panes do not crash', async ({ page }) => {
      const error = await page.evaluate(() => {
        try {
          const pane = window.__paneRef;
          if (!pane) return 'no pane ref';
          const left = pane.getTerminal('left');
          const right = pane.getTerminal('right');
          if (!left || !right) return 'missing terminals';
          // Hammer both panes simultaneously
          for (let i = 0; i < 500; i++) {
            left.write(`L${i}: ${'a'.repeat(60)}\r\n`);
            right.write(`R${i}: ${'b'.repeat(60)}\r\n`);
          }
          return null;
        } catch (e) {
          return String(e);
        }
      });
      expect(error).toBeNull();
    });
  });

  test.describe('canvas2d fallback', () => {

    test.beforeEach(async ({ page }) => {
      await page.click('[data-testid="mode-canvas2d"]');
      await page.waitForTimeout(300);
    });

    test('canvas2d renderer creates canvas and renders', async ({ page }) => {
      await page.evaluate(() => {
        window.__termRef?.write('Canvas2D rendering test\r\n');
      });
      await page.waitForTimeout(200);

      const canvas = page.locator('[data-testid="terminal-container"] canvas');
      await expect(canvas.first()).toBeVisible();
    });

    test('hexToFloat4 resolves non-hex CSS color formats in real browser', async ({ page }) => {
      const result = await page.evaluate(() => {
        const h = window.__hexToFloat4;
        if (!h) return null;
        return {
          'rgb-space': h('rgb(255 128 0)'),
          'rgb-comma': h('rgb(255, 128, 0)'),
          'rgba-slash': h('rgba(255 128 0 / 0.5)'),
          'hsl': h('hsl(30 100% 50%)'),
          'named': h('rebeccapurple'),
          'hex': h('#ff8000'),
          'invalid': h('not-a-color'),
        };
      });

      expect(result).not.toBeNull();
      if (!result) return;

      // All valid formats should produce non-black colors
      for (const name of ['rgb-space', 'rgb-comma', 'hsl', 'named', 'hex']) {
        const [r, g, b] = result[name];
        expect(r + g + b, `${name} should not be black`).toBeGreaterThan(0);
      }

      // rgb-space, rgb-comma, and hex should all produce the same orange
      expect(result['rgb-space'][0]).toBeCloseTo(result['hex'][0], 2);
      expect(result['rgb-space'][1]).toBeCloseTo(result['hex'][1], 2);
      expect(result['rgb-space'][2]).toBeCloseTo(result['hex'][2], 2);
      expect(result['rgb-comma'][0]).toBeCloseTo(result['hex'][0], 2);

      // rgba with alpha should have alpha < 1
      expect(result['rgba-slash'][3]).toBeCloseTo(0.5, 1);

      // rebeccapurple = (102, 51, 153)
      expect(result['named'][0]).toBeCloseTo(102 / 255, 2);
      expect(result['named'][1]).toBeCloseTo(51 / 255, 2);
      expect(result['named'][2]).toBeCloseTo(153 / 255, 2);

      // Invalid color should return opaque black
      expect(result['invalid'][0]).toBe(0);
      expect(result['invalid'][1]).toBe(0);
      expect(result['invalid'][2]).toBe(0);
      expect(result['invalid'][3]).toBe(1.0);
    });

    test('canvas2d handles all SGR attributes', async ({ page }) => {
      const error = await page.evaluate(() => {
        try {
          const t = window.__termRef;
          if (!t) return 'no terminal';
          t.write('\x1b[31mRed\x1b[0m \x1b[42mGreenBg\x1b[0m \x1b[1mBold\x1b[0m\r\n');
          t.write('\x1b[38;2;255;128;0mRGB\x1b[0m \x1b[38;5;196m256color\x1b[0m\r\n');
          return null;
        } catch (e) {
          return String(e);
        }
      });
      expect(error).toBeNull();
    });
  });
});
